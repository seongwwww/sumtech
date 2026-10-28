const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { environment } = require('./helpers.cjs');
test('Codex/Claude selection validates input and Claude uses bounded JSON, no tools, no shell, no fallback', async () => {
  const { selectedBackend, claudeAnswer } = await import('../claude.mjs');
  assert.equal(selectedBackend([]), 'codex');
  assert.equal(selectedBackend(['--agent', 'claude']), 'claude');
  assert.throws(() => selectedBackend(['--agent']), /codex or claude/);
  let invocation;
  const launch = (exe, args, options) => {
    invocation = { exe, args, options };
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', 1));
    setImmediate(() => { child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '문서에 따른 응답', is_error: false })); child.emit('close', 0); });
    return child;
  };
  assert.equal(await claudeAnswer('질문', { document: '문서' }, { executable: 'C:/test/claude.exe', launch }), '문서에 따른 응답');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
  assert.ok(invocation.args.includes('--no-session-persistence'));
  assert.ok(invocation.args.includes('--strict-mcp-config'));
  const failure = (mode) => () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', 1));
    if (mode !== 'timeout') setImmediate(() => { child.stdout.write(mode === 'malformed' ? 'bad JSON' : JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'auth expired' })); child.emit('close', 0); });
    return child;
  };
  for (const mode of ['malformed', 'auth', 'timeout']) await assert.rejects(claudeAnswer('q', {}, { executable: 'C:/test/claude.exe', launch: failure(mode), timeout: 20 }));
});
test('Korean rollout kit has ten slots, installation/report/context/notification/agent/lifecycle commands and explicit verification limits', async () => {
  const root = path.resolve(__dirname, '..');
  const readme = await fs.readFile(path.join(root, 'README.ko.md'), 'utf8');
  for (const word of ['npm ci', 'npm test', '--report-p001', '--report', '--reply-once', '--listen', '--watch-config', '--agent claude', 'run.ps1', 'status.ps1', 'stop.ps1', 'DPAPI', '10', 'OAuth', 'push']) assert.ok(readme.includes(word), word);
  const roster = await fs.readFile(path.join(root, 'docs/rollout-checklist.csv'), 'utf8');
  assert.equal(roster.trim().split(/\r?\n/).length, 11);
  assert.equal((roster.match(/미설치/g) ?? []).length, 10);
  assert.doesNotMatch(roster, /배포완료/);
  for (const script of ['run', 'status', 'stop']) assert.ok((await fs.stat(path.join(root, `scripts/${script}.ps1`))).size > 0);
});
test('Windows lifecycle scripts start, identify, reject duplicate launch and stop their own process (paths with spaces)', async (t) => {
  const dir = await environment(t);
  const { execFileSync, spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..'), state = path.join(dir, 'runner with spaces');
  const ps = 'pwsh.exe';
  // Run the real host with a local idle worker fixture. This checks lifecycle
  // without contacting Buzz or executing an assistant.
  const copyRoot = path.join(dir, 'source with spaces');
  await fs.mkdir(path.join(copyRoot, 'scripts'), { recursive: true });
  for (const name of ['run', 'status', 'stop']) await fs.copyFile(path.join(root, `scripts/${name}.ps1`), path.join(copyRoot, `scripts/${name}.ps1`));
  for (const name of ['host.mjs', 'launch.mjs']) await fs.copyFile(path.join(root, `scripts/${name}`), path.join(copyRoot, `scripts/${name}`));
  await fs.writeFile(path.join(copyRoot, 'receive-mentions.mjs'), 'setInterval(() => {}, 1000);');
  const call = (name) => execFileSync(ps, ['-NoProfile', '-NonInteractive', '-File', path.join(copyRoot, `scripts/${name}.ps1`), '-StateDirectory', state], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  try {
  assert.match(call('run'), /RUNNING/);
  assert.match(call('status'), /RUNNING/);
  const duplicate = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', path.join(copyRoot, 'scripts/run.ps1'), '-StateDirectory', state], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /already running/);
  assert.match(call('stop'), /STOPPED/); assert.match(call('status'), /STOPPED/);
  await fs.writeFile(path.join(state, 'runner.json'), JSON.stringify({ pid: process.pid, instance: 'a'.repeat(32) }));
  assert.throws(() => call('stop'), /STALE/);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  await fs.unlink(path.join(state, 'runner.json'));
  } finally { try { call('stop'); } catch {} }
});

test('ten developer configurations create distinct DPAPI identities outside the source tree', { timeout: 180000 }, async (t) => {
  const dir = await environment(t);
  const { spawnSync } = require('node:child_process');
  const keys = new Set(), configs = new Set(), identities = new Set();
  for (const letter of 'ABCDEFGHIJ') {
    const data = path.join(dir, `developer ${letter}`), config = path.join(data, 'config.json');
    const env = { ...process.env, LOCALAPPDATA: data, BUZZ_BRIDGE_CONFIG: config };
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/setup-agent.mjs'),
      '--name', `Agent-${letter}`, '--caller', 'b'.repeat(64)], { env, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(result.status, 0, result.stderr);
    const identityPath = path.join(data, 'BuzzBridge', `agent-${letter.toLowerCase()}.identity.json`);
    const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    assert.equal(identity.agent, `Agent-${letter}`);
    assert.equal(identity.protection, 'Windows DPAPI CurrentUser');
    assert.match(identity.encrypted_private_key, /^01000000/);
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')).allowed_callers, ['b'.repeat(64)]);
    keys.add(identity.public_key); configs.add(config); identities.add(identityPath);
    const repeat = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/setup-agent.mjs'),
      '--name', `Agent-${letter}`], { env, windowsHide: true, timeout: 25000 });
    assert.notEqual(repeat.status, 0);
    assert.equal(JSON.parse(await fs.readFile(identityPath, 'utf8')).public_key, identity.public_key);
  }
  assert.equal(keys.size, 10); assert.equal(configs.size, 10); assert.equal(identities.size, 10);
});

test('two Windows configurations propagate separate config/data and stopping one preserves the other', { timeout: 120000 }, async (t) => {
  const dir = await environment(t), root = path.resolve(__dirname, '..');
  const { execFileSync } = require('node:child_process');
  const copyRoot = path.join(dir, 'portable source');
  await fs.mkdir(path.join(copyRoot, 'scripts'), { recursive: true });
  for (const file of ['run.ps1', 'status.ps1', 'stop.ps1', 'host.mjs', 'launch.mjs']) {
    await fs.copyFile(path.join(root, 'scripts', file), path.join(copyRoot, 'scripts', file));
  }
  // Deliberately a fixture worker: live service readiness is verified separately.
  await fs.writeFile(path.join(copyRoot, 'receive-mentions.mjs'),
    `console.log(JSON.stringify({config:process.env.BUZZ_BRIDGE_CONFIG,data:process.env.LOCALAPPDATA,args:process.argv.slice(2)})); setInterval(()=>{},1000);`);
  const profiles = ['one', 'two'].map(name => ({ data: path.join(dir, `developer ${name}`), config: path.join(dir, `${name}.json`) }));
  for (const profile of profiles) await fs.writeFile(profile.config, '{}');
  const call = (name, profile, extra = []) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(copyRoot, 'scripts', `${name}.ps1`), '-DataDirectory', profile.data, ...extra],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  try {
    for (const [i, profile] of profiles.entries()) {
      assert.match(call('run', profile, ['-Config', profile.config, '-Agent', i ? 'claude' : 'codex']), /RUNNING/);
      const stdout = await fs.readFile(path.join(profile.data, 'BuzzBridge/runner/stdout.log'), 'utf8');
      const actual = JSON.parse(stdout.trim());
      // Windows TEMP may use an 8.3 alias (RUNNER~1) while PowerShell/Node
      // resolves the same folder to its long name. Compare directory identity.
      assert.equal(await fs.realpath(actual.config), await fs.realpath(profile.config));
      assert.equal(await fs.realpath(actual.data), await fs.realpath(profile.data));
      assert.ok(actual.args.includes(i ? 'claude' : 'codex'));
    }
    const record = profile => fs.readFile(path.join(profile.data, 'BuzzBridge/runner/runner.json'), 'utf8').then(JSON.parse);
    const first = await record(profiles[0]), second = await record(profiles[1]);
    assert.notEqual(first.pid, second.pid); assert.notEqual(first.instance, second.instance);
    assert.match(call('stop', profiles[0]), /STOPPED/);
    assert.match(call('status', profiles[0]), /STOPPED/);
    assert.match(call('status', profiles[1]), new RegExp(`RUNNING pid=${second.pid} agent=claude`));
    assert.doesNotThrow(() => process.kill(second.pid, 0));
    assert.match(call('stop', profiles[1]), /STOPPED/);
    assert.match(call('status', profiles[1]), /STOPPED/);
  } finally { for (const profile of profiles) { try { call('stop', profile); } catch {} } }
});
