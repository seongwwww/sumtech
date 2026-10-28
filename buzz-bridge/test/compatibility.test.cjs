const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const { environment, relay } = require('./helpers.cjs');
const cwd = path.resolve(__dirname, '..');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

for (const backend of ['codex', 'claude']) {
  test(`${backend}: explicit selection, native invocation, successful answer and bounded failure reporting`, async (t) => {
    await environment(t);
    const { selectedBackend, claudeAnswer } = await import('../claude.mjs');
    const { codexAnswer } = await import('../receive-mentions.mjs');
    assert.equal(selectedBackend(['--agent', backend]), backend);
    assert.equal(selectedBackend([]), 'codex');
    assert.throws(() => selectedBackend(['--agent']), /codex or claude/);
    let invocation, prompt;
    const launch = (mode) => (exe, args, options) => {
      invocation = { exe, args, options };
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      prompt = ''; child.stdin.on('data', (chunk) => { prompt += chunk; });
      child.kill = () => setImmediate(() => child.emit('close', 1));
      setImmediate(() => {
        if (mode === 'timeout') return;
        if (mode === 'spawn') { child.emit('error', new Error('synthetic')); child.emit('close', 1); return; }
        const result = backend === 'codex'
          ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'source:decision.md polling' } }) + '\n' + JSON.stringify({ type: mode === 'auth' ? 'turn.failed' : 'turn.completed' }) + '\n'
          : JSON.stringify({ type: 'result', subtype: 'success', is_error: mode === 'auth', result: 'source:decision.md polling' });
        child.stdout.write(mode === 'malformed' ? 'invalid\n' : result);
        child.emit('close', mode === 'exit' ? 1 : 0);
      });
      return child;
    };
    const answer = backend === 'codex' ? codexAnswer : claudeAnswer;
    const executable = backend === 'codex' ? { cli: 'C:/fixture/codex.exe', packageRoot: 'C:/fixture' } : 'C:/fixture/claude.exe';
    assert.equal(await answer('decision?', { sources: [{ id: 'decision.md' }] }, { executable, launch: launch('ok') }), 'source:decision.md polling');
    assert.match(prompt, /decision.md/);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.windowsHide, true);
    assert.ok(invocation.args.includes(backend === 'codex' ? '--ephemeral' : '--no-session-persistence'));
    assert.equal(invocation.options.env.GITHUB_TOKEN, undefined);
    for (const mode of ['auth', 'exit', 'spawn', 'malformed', 'timeout']) {
      await assert.rejects(answer('q', null, { executable, launch: launch(mode), timeout: 20 }),
        backend === 'codex' ? /Codex/ : /Claude/);
    }
  });

  test(`${backend}: Windows status reports selected backend and startup failure is observable`, async (t) => {
    const dir = await environment(t);
    const copy = path.join(dir, 'bridge with spaces'), state = path.join(dir, 'runner');
    await fs.mkdir(path.join(copy, 'scripts'), { recursive: true });
    for (const file of ['run.ps1', 'status.ps1', 'stop.ps1', 'host.mjs', 'launch.mjs']) {
      await fs.copyFile(path.join(cwd, 'scripts', file), path.join(copy, 'scripts', file));
    }
    await fs.writeFile(path.join(copy, 'receive-mentions.mjs'), "console.log('FIXTURE_AGENT=' + process.argv[process.argv.indexOf('--agent') + 1]); setInterval(() => {}, 1000);");
    const call = (name, extra = []) => execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(copy, 'scripts', `${name}.ps1`), '-StateDirectory', state, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    try {
      assert.match(call('run', ['-Agent', backend]), new RegExp(`agent=${backend}`));
      assert.match(call('status'), new RegExp(`agent=${backend}`));
      assert.match(await fs.readFile(path.join(state, 'stdout.log'), 'utf8'), new RegExp(`FIXTURE_AGENT=${backend}`));
    } finally { call('stop'); }
    assert.match(call('status'), /STOPPED/);
    await fs.writeFile(path.join(copy, 'receive-mentions.mjs'), "console.error('FIXTURE_INVOCATION_FAILED'); process.exit(7);");
    assert.throws(() => call('run', ['-Agent', backend]), /exited during startup/);
    assert.match(await fs.readFile(path.join(state, 'stderr.log'), 'utf8'), /FIXTURE_INVOCATION_FAILED/);
    assert.match(call('status'), /STOPPED/);
  });
}
test('old self-test and P001 preview commands remain compatible; report entry validates and previews generic JSON without identity', async (t) => {
  const dir = await environment(t);
  const output = execFileSync(process.execPath, ['receive-mentions.mjs', '--self-test'], { cwd, encoding: 'utf8' });
  assert.match(output, /SELF_TEST_PASS/);
  assert.match(execFileSync(process.execPath, ['receive-mentions.mjs', '--report-p001', '--preview-report'], { cwd, encoding: 'utf8' }), /P001/);
  assert.match(execFileSync(process.execPath, ['receive-mentions.mjs', '--report', 'config/report.example.json', '--preview-report'], { cwd, encoding: 'utf8' }), /P002/);
  for (const args of [['--report'], ['--report', '--listen'], ['--report-p001', '--listen'], ['--reply-once', '--listen'], ['--agent', 'unknown']]) {
    assert.notEqual(spawnSync(process.execPath, ['receive-mentions.mjs', ...args], { cwd }).status, 0);
  }
  assert.equal((await fs.readdir(dir)).length, 0);
});
test('child PSModulePath ignores inherited casing and supports DPAPI roundtrip without changing parent environment', async () => {
  const { windowsPowerShellEnv } = await import('../windows-env.mjs');
  const source = { SystemRoot: process.env.SystemRoot, pSmOdUlEpAtH: 'broken', PSModulePath: 'also broken', Path: 'keep' };
  const child = windowsPowerShellEnv(source);
  assert.deepEqual(Object.keys(child).filter((x) => x.toLowerCase() === 'psmodulepath'), ['PSModulePath']);
  assert.equal(source.PSModulePath, 'also broken');
  assert.match(child.PSModulePath, /System32.*WindowsPowerShell.*Modules$/);
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = "$ErrorActionPreference='Stop'; $a=ConvertTo-SecureString 'synthetic-test' -AsPlainText -Force; $b=ConvertFrom-SecureString $a; $c=ConvertTo-SecureString $b; if ($c.Length -ne 14) { throw 'Roundtrip failed' }; 'DPAPI_TEST_PASS'";
  assert.match(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { env: windowsPowerShellEnv(), encoding: 'utf8', windowsHide: true }), /DPAPI_TEST_PASS/);
});
test('authorized mentions produce one bounded answer in original thread, reject outsiders and recover after restart', async (t) => {
  await environment(t);
  const { generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools');
  const { respond, threadRoot } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), human = generateSecretKey();
  const agent = getPublicKey(secret), owner = getPublicKey(human), r = relay();
  const root = finalizeEvent({ kind: 9, created_at: 1, tags: [['h', 'channel']], content: 'report' }, secret);
  r.events.set(root.id, root);
  assert.equal(await threadRoot({ id: 'a'.repeat(64), tags: [['e', root.id, '', 'root']] }, 'channel', r.query), root.id);
  const mention = finalizeEvent({ kind: 9, created_at: 2, tags: [['h', 'channel'], ['p', agent], ['e', root.id, '', 'root'], ['e', root.id, '', 'reply']], content: 'P002 CI 설명' }, human);
  let executions = 0, authorities = 0;
  const options = { owner, agent, authority: async () => { authorities++; }, contextFor: async () => ({ issue: 2, ci: 'failed' }), answer: async (q, c) => { executions++; assert.equal(c.ci, 'failed'); return '제공된 CI는 실패입니다.'; } };
  await respond(mention, 'channel', secret, r.query, r.post, options);
  await respond(mention, 'channel', secret, r.query, r.post, options);
  assert.equal(executions, 1); assert.equal(r.posts, 1); assert.ok(authorities >= 3);
  const reply = [...r.events.values()].at(-1);
  assert.ok(reply.tags.some((x) => x[0] === 'e' && x[1] === root.id && x[3] === 'root'));
  assert.ok(reply.tags.some((x) => x[0] === 'e' && x[1] === mention.id && x[3] === 'reply'));
  const outsider = finalizeEvent({ kind: 9, created_at: 3, tags: [['h', 'channel'], ['p', agent]], content: 'fake' }, secret);
  await assert.rejects(respond(outsider, 'channel', secret, r.query, r.post, options), /verification failed/);
  await assert.rejects(threadRoot({ ...mention, tags: [...mention.tags, ['e', 'f'.repeat(64), '', 'root']] }, 'channel', r.query), /Ambiguous/);
});

test('ready replies reconcile lost receipt without rerunning model; failed model and revoked authority never post', async (t) => {
  await environment(t);
  const { generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools');
  const { respond } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), human = generateSecretKey();
  const owner = getPublicKey(human), agent = getPublicKey(secret), r = relay();
  const mention = (text) => finalizeEvent({ kind: 9, created_at: 1, tags: [['h', 'channel'], ['p', agent]], content: text }, human);
  let models = 0;
  const options = { owner, agent, authority: async () => {}, contextFor: async () => null, answer: async () => { models++; return 'answer'; } };
  const first = mention('recover');
  await assert.rejects(respond(first, 'channel', secret, r.query, async (...args) => { await r.post(...args); throw new Error('lost receipt'); }, options));
  await respond(first, 'channel', secret, r.query, r.post, options);
  assert.equal(models, 1); assert.equal(r.posts, 1);
  const failed = mention('failed');
  await assert.rejects(respond(failed, 'channel', secret, r.query, r.post, { ...options, answer: async () => { throw new Error('model unavailable'); } }), /unavailable/);
  await assert.rejects(respond(failed, 'channel', secret, r.query, r.post, options), /refusing automatic re-execution/);
  let authorityCalls = 0;
  await assert.rejects(respond(mention('revoked'), 'channel', secret, r.query, r.post, { ...options,
    authority: async () => { if (++authorityCalls > 1) throw new Error('revoked'); } }), /revoked/);
  assert.equal(r.posts, 1);
});
