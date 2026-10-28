const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./project-fixtures.cjs');

test('existing PowerShell-style backend flags and new project CLI flags select the same requested backend', async (t) => {
  const f=await fixture(t);
  assert.match(f.run('alpha',`import assert from 'node:assert/strict';import {managedArgs} from './scripts/project.mjs';
    for(const flags of [['--agent','claude'],['-Agent','claude'],['-agent','claude']]) { const args=managedArgs('start',flags);assert.equal(args[args.indexOf('-Agent')+1],'claude'); }
    console.log('BACKEND_FLAGS_PASS');`),/BACKEND_FLAGS_PASS/);
});

test('non-owner developer can mention their reused Agent after a new project owner is discovered', async (t) => {
  const f = await fixture(t);
  assert.match(f.run('alpha', `import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';
    import {finalizeEvent,getPublicKey,verifyEvent} from 'nostr-tools';import {project,stateDirectory} from './projects.mjs';import {settings} from './settings.mjs';import {receive} from './receive-mentions.mjs';
    const agentKey=new Uint8Array(32).fill(1),callerKey=new Uint8Array(32).fill(2),signerKey=new Uint8Array(32).fill(3);
    const caller=getPublicKey(callerKey),owner=getPublicKey(signerKey),channel='project-channel';
    const event=(kind,tags,key=signerKey)=>finalizeEvent({kind,created_at:Math.floor(Date.now()/1000),content:'P001 question',tags},key);
    const events=[event(39000,[['d',channel],['name',project.report_channel]]),event(39001,[['d',channel],['p',owner,'owner']]),event(39002,[['d',channel],['p',settings.agentPublicKey],['p',caller]])];
    globalThis.fetch=async(url,options)=>{assert.equal(url,project.origin+'/query');
      const auth=JSON.parse(Buffer.from(options.headers.Authorization.slice(6),'base64').toString());assert.ok(verifyEvent(auth));assert.equal(auth.pubkey,settings.agentPublicKey);
      const [filter]=JSON.parse(options.body);
      if(filter.kinds.includes(9)){assert.ok(filter.authors.includes(caller),'developer caller was lost during owner discovery');process.emit('SIGTERM');return new Response(JSON.stringify([event(9,[['h',channel],['p',settings.agentPublicKey]],callerKey)]));}
      return new Response(JSON.stringify(events.filter(e=>filter.kinds.includes(e.kind)&&(!filter.authors||filter.authors.includes(e.pubkey)))));};
    await receive(agentKey);const files=(await readdir(stateDirectory())).filter(n=>/^listener-.*[.]json$/.test(n));
    const queue=JSON.parse(await readFile(join(stateDirectory(),files[0]),'utf8'));assert.equal(queue.owner,owner);assert.equal(queue.pending.length,1);assert.equal(queue.pending[0].event.pubkey,caller);
    console.log('REUSED_DEVELOPER_CALLER_PASS');`, ['--', '--listen']), /REUSED_DEVELOPER_CALLER_PASS/);
});

test('legacy P001/P002 mappings and developer identity bytes survive named selection and context reads', async (t) => {
  const f = await fixture(t);
  const base = path.join(f.dir, 'BuzzBridge');
  await fs.mkdir(path.join(base, 'tasks'), { recursive: true });
  const { finalizeEvent } = await import('nostr-tools');
  const files = [];
  const identity = path.join(base, 'agent-b.identity.json');
  await fs.writeFile(identity, JSON.stringify({ public_key: f.agent, encrypted_private_key: 'opaque-fixture-do-not-overwrite' }));
  files.push(identity);
  for (const id of ['P001', 'P002']) {
    const root = finalizeEvent({kind:9,created_at:1,tags:[['h','legacy-channel']],content:id},new Uint8Array(32).fill(1));
    const task = {task_id:id,repository:'seongwwww/sumtech',title:id+' preserved',status:'completed',summary:'historical fixture',changed_files:[],tests:{status:'passed'},issue:1,documents:[]};
    const file = path.join(base,'tasks',id+'.json');
    await fs.writeFile(file,JSON.stringify({version:1,task_id:id,repository:task.repository,relay_url:'https://buzz-ciik.srv2103980.hstgr.cloud',channel_id:'legacy-channel',root_event_id:root.id,status:'posted',signed_root:root,task_definition:task}));files.push(file);
  }
  const before = await Promise.all(files.map(file=>fs.readFile(file,'utf8')));
  f.cli('use','beta');
  assert.match(f.run('legacy', `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
    import {settings} from './settings.mjs';import {stateDirectory} from './projects.mjs';import {taskContext} from './receive-mentions.mjs';
    assert.equal(settings.identityPath,join(process.env.LOCALAPPDATA,'BuzzBridge','agent-b.identity.json'));
    for(const id of ['P001','P002']){const m=JSON.parse(await readFile(join(stateDirectory(),'tasks',id+'.json'),'utf8'));
      const q=async f=>f.ids?[m.signed_root]:[];const record=(task,type)=>type==='runs'?[]:type==='pr'?null:{number:1,title:'historical Issue',state:'CLOSED',url:'https://github.com/seongwwww/sumtech/issues/1',body:'history'};
      const c=await taskContext(id,'legacy-channel',m.root_event_id,q,record);assert.equal(c.task.title,id+' preserved');assert.equal(c.github_issue.number,1);}
    console.log('LEGACY_HISTORY_PASS');`), /LEGACY_HISTORY_PASS/);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before);
});

test('explicit legacy lifecycle remains reachable with an invalid new registry; Paseo lifecycle uses the project-aware CLI', async (t) => {
  const f = await fixture(t);
  const registry = path.join(f.dir,'BuzzBridge/projects.json');
  await fs.writeFile(registry,'{invalid json');
  assert.match(f.cli('status','--project','legacy'),/PROJECT=legacy[\s\S]*STOPPED/);
  assert.match(f.cli('stop','--project','legacy'),/STOPPED/);
  assert.equal(await fs.readFile(registry,'utf8'),'{invalid json');
  const paseo = JSON.parse(await fs.readFile(path.join(f.cwd,'../paseo.json'),'utf8'));
  assert.match(paseo.scripts['Buzz 상태'].command,/npm\.cmd.*run status/);
  assert.match(paseo.scripts['Buzz 종료'].command,/npm\.cmd.*stop/);
});
