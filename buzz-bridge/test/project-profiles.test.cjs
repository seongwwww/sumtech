const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const cwd = path.resolve(__dirname, '..');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buzz-projects-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, LOCALAPPDATA: dir, BUZZ_PROJECT: '', BUZZ_PROJECT_SNAPSHOT: '', BUZZ_BRIDGE_CONFIG: path.join(dir, 'local.json') };
  const {getPublicKey} = await import('nostr-tools');
  await fs.writeFile(env.BUZZ_BRIDGE_CONFIG, JSON.stringify({ agent_name: 'Agent-B', agent_public_key: getPublicKey(new Uint8Array(32).fill(1)) }));
  const cli = (...args) => execFileSync(process.execPath, ['scripts/project.mjs', ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
  for (const name of ['alpha', 'beta']) {
    const workspace = path.join(dir, `${name} repository with spaces`);
    await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'decision.md'), `Decision for ${name}: polling`);
    cli('add', name, '--repo', `team/${name}`, '--relay', `wss://${name}.example/`, '--workspace', workspace,
      '--channels', `${name}-chat,${name}-reports`, '--report-channel', `${name}-reports`);
  }
  const run = (name, code, args = []) => execFileSync(process.execPath, ['--input-type=module', '-e', code, ...args],
    { cwd, env: { ...env, BUZZ_PROJECT: name }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { dir, env, cli, run };
}

test('one installation adds/lists/selects projects, normalizes origins, retains legacy and pins running snapshots', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse(f.cli('list')).projects, ['legacy', 'alpha', 'beta']);
  f.cli('use', 'alpha');
  assert.equal(JSON.parse(f.cli('list')).selected, 'alpha');
  f.run('alpha', `import assert from 'node:assert/strict'; import { project, selectProject, legacy } from './projects.mjs';
    assert.equal(project.origin, 'https://alpha.example'); assert.equal(project.relay, 'wss://alpha.example/');
    assert.equal(selectProject(process.env, ['node', '--project', 'beta']).name, 'beta');
    assert.equal(selectProject(process.env, ['node', '--project', 'legacy']), legacy);
    assert.throws(() => selectProject(process.env, ['node', '--project', 'missing']), /Unknown project/);
    assert.throws(() => selectProject(process.env, ['node', '--project']), /requires/);
    assert.equal(selectProject({...process.env, BUZZ_PROJECT_SNAPSHOT: JSON.stringify(project)}, ['node', '--project', 'beta']).name, 'alpha');`);
  f.cli('use', 'beta');
  assert.equal(JSON.parse(f.cli('list')).selected, 'beta');
  assert.notEqual(spawnSync(process.execPath, ['scripts/project.mjs', 'add', 'alpha'], { cwd, env: f.env }).status, 0);
  assert.match(f.cli('status', '--project', 'alpha'), /STOPPED/);
  assert.match(f.cli('stop', '--project', 'beta'), /STOPPED/);
  assert.equal(await fs.readFile(path.join(cwd, 'tasks/P001.json'), 'utf8').then(JSON.parse).then(x => x.task_id), 'P001');
  f.run('legacy', `import assert from 'node:assert/strict'; import {stateDirectory} from './projects.mjs'; import {settings} from './settings.mjs'; import {join} from 'node:path';
    assert.equal(stateDirectory(), join(process.env.LOCALAPPDATA, 'BuzzBridge'));
    assert.equal(settings.identityPath, join(process.env.LOCALAPPDATA, 'BuzzBridge', 'agent-b.identity.json'));`);
});

test('two repositories reuse P001 and generic identities with isolated reports, replies, documents, polls and restart queues', async (t) => {
  const f = await fixture(t);
  const worker = `
    import assert from 'node:assert/strict'; import {readFile,writeFile,mkdir} from 'node:fs/promises'; import {join} from 'node:path';
    import {project,stateDirectory} from './projects.mjs'; import {settings} from './settings.mjs';
    import {validateTask,publishTaskReport,taskContext,respond,mergePending} from './receive-mentions.mjs';
    import {pollNotifications,validateWatchConfig} from './notifications.mjs'; import {finalizeEvent,getPublicKey} from 'nostr-tools';
    const secret = new Uint8Array(32).fill(1), human = new Uint8Array(32).fill(2), agent=getPublicKey(secret), owner=getPublicKey(human);
    const dir=stateDirectory(), file=join(dir,'fixture-relay.json'), channel=project.report_channel;
    await mkdir(dir,{recursive:true}); let events=[]; try { events=JSON.parse(await readFile(file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
    let posts=0; const query=async f=>events.filter(e=>(!f.ids||f.ids.includes(e.id))&&(!f['#h']||f['#h'].includes(e.tags.find(t=>t[0]==='h')?.[1])));
    const post=async (url,event)=>{assert.equal(url,'/events');assert.equal(event.tags.find(t=>t[0]==='h')[1],channel);events.push(event);posts++;await writeFile(file,JSON.stringify(events));return {accepted:true};};
    const task=validateTask({project:project.name,task_id:'P001',repository:project.repository,title:project.name,status:'completed',summary:'fixture',changed_files:[],tests:'fixture',issue:1,pull_request:2,documents:['decision.md']});
    assert.throws(()=>validateTask({...task,project:project.name==='alpha'?'beta':'alpha'}),/cross-project/);
    assert.throws(()=>validateTask({...task,repository:'other/repo'}),/Task needs/);
    assert.throws(()=>validateWatchConfig({repository:'other/repo',channel,tasks:[{task_id:'P001'}]}),/Invalid/);
    const record=(task,type)=>type==='runs'?[]:{number:type==='issue'?1:2,title:type,state:'OPEN',url:'https://github.com/'+task.repository+'/'+(type==='issue'?'issues/1':'pull/2'),headRefOid:'abc',statusCheckRollup:[],reviews:[]};
    await publishTaskReport(channel,secret,query,post,task,record);
    const mapping=JSON.parse(await readFile(join(dir,'tasks/P001.json'),'utf8'));assert.equal(mapping.repository,project.repository);assert.equal(mapping.relay_url,project.origin);
    const context=await taskContext('P001',channel,mapping.root_event_id,query,record);assert.equal(context.task.repository,project.repository);assert.match(context.project_documents[0].content,new RegExp(project.name));assert.equal(context.github_issue.number,1);assert.equal(context.github_pr.number,2);
    const envelope={project:project.name,reportId:'same',threadId:'same',revisionId:'r1',submissionKey:'same',payload:{name:project.name}};
    await publishTaskReport(channel,secret,query,post,validateTask(envelope));
    const mention=finalizeEvent({kind:9,created_at:2,tags:[['h',channel],['p',agent]],content:'P001'},human);
    await respond(mention,channel,secret,query,post,{agent,owner,authority:async()=>{},contextFor:async()=>context,answer:async()=>project.name});
    const config={repository:project.repository,channel,tasks:[{task_id:'P001',issue:1}],interval_seconds:30};
    const options={config,channel,secret,query,post,path:join(dir,'github-notifications.json'),githubRecord:record};
    if(!process.argv.includes('--restart')) await pollNotifications(options);
    const changed=(task,type)=>type==='issue'?{...record(task,type),state:'CLOSED'}:record(task,type);
    await pollNotifications({...options,githubRecord:changed});await pollNotifications({...options,githubRecord:changed});
    const queueFile=join(dir,'listener-fixture.json');let queue;try{queue=JSON.parse(await readFile(queueFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;queue={seen:[],pending:[],cursors:{[channel]:1}};}
    const queuedMention=finalizeEvent({kind:9,created_at:2,tags:[['h',channel],['p',settings.agentPublicKey]],content:'queued'},human);mergePending(queue,channel,[queuedMention],3,owner);assert.equal(queue.pending.length,1);assert.equal(queue.cursors[channel],3);await writeFile(queueFile,JSON.stringify(queue));
    assert.equal(settings.identityPath,join(process.env.LOCALAPPDATA,'BuzzBridge','agent-b.identity.json'));
    if(process.argv.includes('--restart')) assert.equal(posts,0);
    console.log('PROFILE_FIXTURE_PASS');`;
  for (const name of ['alpha', 'beta']) { assert.match(f.run(name, worker), /PROFILE_FIXTURE_PASS/); assert.match(f.run(name, worker, ['--', '--restart']), /PROFILE_FIXTURE_PASS/); }
  for (const name of ['alpha', 'beta']) {
    const base = path.join(f.dir, 'BuzzBridge/projects', name);
    for (const file of ['tasks/P001.json', 'github-notifications.json', 'listener-fixture.json']) assert.ok((await fs.stat(path.join(base, file))).isFile());
    assert.equal((await fs.readdir(path.join(base,'reports'))).filter(x=>x.endsWith('.json')).length,2);
    assert.equal((await fs.readdir(path.join(base,'reply-tests'))).length,1);
  }
  await assert.rejects(fs.stat(path.join(f.dir,'BuzzBridge/tasks')), /ENOENT/);
});

test('connect discovers signed protocol metadata and rejects missing membership without posting', async (t) => {
  const f = await fixture(t);
  for (const name of ['alpha', 'beta']) for (const denied of [false, true]) {
    const output = f.run(name, `import assert from 'node:assert/strict';import {finalizeEvent,getPublicKey} from 'nostr-tools';
      import {project} from './projects.mjs';import {settings} from './settings.mjs';import {receive} from './receive-mentions.mjs';
      const secret=new Uint8Array(32).fill(3), signer=getPublicKey(secret), owner='b'.repeat(64);let calls=0;
      const event=(kind,channel,tags)=>finalizeEvent({kind,created_at:1,tags:[['d',channel],...tags],content:''},secret);
      const events=project.channels.flatMap((name,i)=>[event(39000,'channel-'+i,[['name',name]]),event(39001,'channel-'+i,[['p',owner,'owner']]),event(39002,'channel-'+i,${denied} ? [] : [['p',settings.agentPublicKey]])]);
      globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,project.origin+'/query');const [f]=JSON.parse(options.body);return new Response(JSON.stringify(events.filter(e=>f.kinds.includes(e.kind)&&(!f.authors||f.authors.includes(e.pubkey))&&(!f['#d']||f['#d'].includes(e.tags[0][1])))));};
      if(${denied}) await assert.rejects(receive(secret),/external prerequisites/);else await receive(secret);
      assert.ok(calls>0);console.log('DISCOVERY_PASS');`, ['--', '--connect']);
    assert.match(output, /DISCOVERY_PASS/);
    if (!denied) assert.match(output, /PROJECT_CONNECTED=/);
  }
});

test('actual listener checkpoints and pending queues remain scoped across relay restarts without running a model after stop', async (t) => {
  const f = await fixture(t);
  const worker = `import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';
    import {finalizeEvent,getPublicKey} from 'nostr-tools';import {project,stateDirectory} from './projects.mjs';import {settings} from './settings.mjs';import {receive} from './receive-mentions.mjs';
    const secret=new Uint8Array(32).fill(1), human=new Uint8Array(32).fill(2), signerKey=new Uint8Array(32).fill(3), owner=getPublicKey(human);
    const sign=(kind,id,tags,key=signerKey)=>finalizeEvent({kind,created_at:Math.floor(Date.now()/1000),tags:[['d',id],...tags],content:'P001'},key);
    const events=project.channels.flatMap((name,i)=>[sign(39000,'shared-id-'+i,[['name',name]]),sign(39001,'shared-id-'+i,[['p',owner,'owner']]),sign(39002,'shared-id-'+i,[['p',settings.agentPublicKey]])]);
    globalThis.fetch=async(url,options)=>{assert.equal(url,project.origin+'/query');const [f]=JSON.parse(options.body);
      if(f.kinds.includes(9)){process.emit('SIGTERM');return new Response(JSON.stringify([sign(9,'mention',[['h',f['#h'][0]],['p',settings.agentPublicKey]],human)]));}
      return new Response(JSON.stringify(events.filter(e=>f.kinds.includes(e.kind)&&(!f.authors||f.authors.includes(e.pubkey))&&(!f['#d']||f['#d'].includes(e.tags[0][1])))));};
    await receive(secret);
    const files=(await readdir(stateDirectory())).filter(n=>/^listener-.*[.]json$/.test(n));assert.equal(files.length,1);
    const state=JSON.parse(await readFile(join(stateDirectory(),files[0]),'utf8'));assert.equal(state.relay,project.origin);assert.equal(state.pending.length,2);assert.equal(state.seen.length,0);assert.equal(Object.keys(state.cursors).length,2);
    console.log('LISTENER_RESTART_PASS');`;
  // A repeat receives the identical event timestamp and validates the persisted queue.
  // Freeze the timestamp in each child so event identities survive an actual process restart.
  const stable = "Date.now=()=>1900000000000;\n" + worker;
  for(const name of ['alpha','beta']) for(let n=0;n<2;n++) assert.match(f.run(name,stable,['--','--listen']),/LISTENER_RESTART_PASS/);
});

test('Windows managed runners pin separate channels, logs, PIDs and stop/restart only the selected project', async (t) => {
  const f = await fixture(t), copy = path.join(f.dir,'shared install with spaces');
  await fs.mkdir(path.join(copy,'scripts'),{recursive:true});
  for (const name of ['host.mjs','launch.mjs','run.ps1','status.ps1','stop.ps1','project.mjs','start-local.mjs']) await fs.copyFile(path.join(cwd,'scripts',name),path.join(copy,'scripts',name));
  for(const name of ['projects.mjs','windows-env.mjs']) await fs.copyFile(path.join(cwd,name),path.join(copy,name));
  await fs.writeFile(path.join(copy,'receive-mentions.mjs'), "console.log(process.env.BUZZ_PROJECT_SNAPSHOT);console.log(JSON.stringify(process.argv));setInterval(()=>{},1000);");
  const registry=JSON.parse(await fs.readFile(path.join(f.dir,'BuzzBridge/projects.json'),'utf8'));
  for(const profile of Object.values(registry.projects)) Object.assign(profile,{owner_public_key:'b'.repeat(64),relay_signer:'c'.repeat(64),channel_ids:Object.fromEntries(profile.channels.map((name,i)=>[name,'channel-'+i]))});
  await fs.writeFile(path.join(f.dir,'BuzzBridge/projects.json'),JSON.stringify(registry));
  const call=(name,command)=>execFileSync(process.execPath,['scripts/project.mjs',command==='run'?'start':command,'--project',name],{cwd:copy,env:f.env,encoding:'utf8',windowsHide:true,timeout:25000});
  const running=new Set();t.after(()=>{for(const name of running)call(name,'stop');});
  for(const name of ['alpha','beta']) { assert.match(call(name,'run'),/RUNNING/);running.add(name); }
  const a=JSON.parse(await fs.readFile(path.join(f.dir,'BuzzBridge/projects/alpha/runner/runner.json'),'utf8'));
  const b=JSON.parse(await fs.readFile(path.join(f.dir,'BuzzBridge/projects/beta/runner/runner.json'),'utf8'));
  assert.notEqual(a.pid,b.pid);assert.notEqual(a.stdout,b.stdout);
  f.cli('use','beta');
  assert.match(await fs.readFile(a.stdout,'utf8'),/alpha-chat,alpha-reports/);
  assert.doesNotMatch(await fs.readFile(a.stdout,'utf8'),/beta-chat/);
  assert.throws(()=>call('alpha','run'),/already running/);
  assert.match(call('alpha','stop'),/STOPPED/);running.delete('alpha');assert.match(call('beta','status'),/RUNNING/);
  assert.match(call('alpha','run'),/RUNNING/);running.add('alpha');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'BuzzBridge/projects/beta/runner/runner.json'),'utf8')).instance,b.instance);
  for(const name of [...running]){call(name,'stop');running.delete(name);}
});
