const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { environment, records, relay } = require('./helpers.cjs');
const config = { repository: 'seongwwww/sumtech', channel: 'test', interval_seconds: 30,
  tasks: [{ task_id: 'P002', issue: 2, pull_request: 3 }] };

test('new repository Issue/PR is discovered after baseline and linked to the task thread without duplicate notifications', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey, finalizeEvent } = await import('nostr-tools');
  const { pollNotifications } = await import('../notifications.mjs');
  const secret = generateSecretKey(), r = relay();
  const root = finalizeEvent({ kind: 9, created_at: 1, tags: [['h', 'channel']], content: 'P004' }, secret);
  r.events.set(root.id, root);
  let discovered = [];
  const options = { config: { ...config, discover_new: true }, channel: 'channel', secret, query: r.query,
    post: r.post, path: path.join(dir, 'discover.json'), rootForTask: async (id) => id === 'P004' ? root.id : null,
    githubRecord: (task, type) => ['issues', 'prs'].includes(type) ? discovered : type === 'runs' ? [] : records(task, type) };
  await pollNotifications(options);
  discovered = [{ number: 4, title: '[P004] new task', state: 'OPEN', updatedAt: 'v1', url: 'https://example.test/4' }];
  assert.equal((await pollNotifications(options)).queued, 2);
  assert.equal((await pollNotifications(options)).queued, 0);
  assert.equal(r.posts, 2);
  for (const e of [...r.events.values()].slice(1)) assert.ok(e.tags.some((tag) => tag[0] === 'e' && tag[1] === root.id));
});
test('poll Issue, PR, review, CI, merge and workflow events; baseline and restart dedup', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey, finalizeEvent } = await import('nostr-tools');
  const { pollNotifications } = await import('../notifications.mjs');
  const r = relay(), secret = generateSecretKey();
  const root = finalizeEvent({ kind: 9, created_at: 1, tags: [['h', 'channel']], content: 'task report' }, secret);
  r.events.set(root.id, root);
  let issueState = 'OPEN', prState = 'OPEN', conclusion = 'PENDING', review = '', runStatus = 'in_progress', updated = 'v1';
  const record = (task, type) => {
    if (type === 'runs') return [{ databaseId: 42, workflowName: 'build', status: runStatus, conclusion: runStatus === 'completed' ? 'success' : '', url: 'https://example.test/run/42' }];
    const value = records(task, type);
    if (type === 'issue') return { ...value, state: issueState, updatedAt: updated };
    return { ...value, state: prState, mergedAt: prState === 'MERGED' ? '2026-10-29' : null,
      reviewDecision: review, reviews: review ? [{ id: 'r1', state: review, author: { login: 'reviewer' } }] : [],
      statusCheckRollup: [{ name: 'build', status: conclusion }] };
  };
  const options = { config, channel: 'channel', secret, query: r.query, post: r.post,
    path: path.join(dir, 'notifications.json'), githubRecord: record, rootForTask: async () => root.id };
  assert.equal((await pollNotifications(options)).baseline, true); assert.equal(r.posts, 0);
  assert.equal((await pollNotifications(options)).queued, 0);
  issueState = 'CLOSED'; updated = 'v2';
  assert.equal((await pollNotifications(options)).queued, 1);
  prState = 'CLOSED'; assert.equal((await pollNotifications(options)).queued, 1);
  review = 'APPROVED'; assert.equal((await pollNotifications(options)).queued, 1);
  conclusion = 'SUCCESS'; assert.equal((await pollNotifications(options)).queued, 1);
  prState = 'MERGED'; assert.equal((await pollNotifications(options)).queued, 1);
  runStatus = 'completed'; assert.equal((await pollNotifications(options)).queued, 1);
  assert.equal(r.posts, 6);
  await pollNotifications({ ...options }); assert.equal(r.posts, 6);
  const notifications = [...r.events.values()].slice(1);
  for (const e of notifications.filter((e) => !e.content.includes('workflow_run'))) assert.ok(e.tags.some((x) => x[0] === 'e' && x[1] === root.id));
  for (const kind of ['issue', 'pr', 'review', 'ci', 'workflow_run']) assert.ok(notifications.some((e) => e.content.includes(`"kind": "${kind}"`)));
  await assert.rejects(pollNotifications({ ...options, config: { ...config, interval_seconds: 60 } }), /mismatch/);
});
test('lost POST receipt/readback and pre-POST outage retain exact event and recover without regeneration', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { pollNotifications } = await import('../notifications.mjs');
  const r = relay(); let state = 'OPEN';
  const record = (task, type) => type === 'runs' ? [] : type === 'pr' ? null : { ...records(task, type), state };
  const options = { config, channel: 'channel', secret: generateSecretKey(), query: r.query, post: r.post,
    path: path.join(dir, 'notifications.json'), githubRecord: record };
  await pollNotifications(options); state = 'CLOSED';
  await assert.rejects(pollNotifications({ ...options, post: async () => { throw new Error('offline'); } }), /offline/);
  const fs = require('node:fs/promises');
  const prepared = JSON.parse(await fs.readFile(options.path)).pending[0];
  await assert.rejects(pollNotifications({ ...options, post: async (...args) => { await r.post(...args); throw new Error('lost response'); } }), /lost response/);
  await pollNotifications(options);
  assert.equal(r.posts, 1); assert.ok(r.events.has(prepared.id));
  state = 'OPEN';
  await assert.rejects(pollNotifications({ ...options, authority: async () => { throw new Error('authority revoked'); } }), /revoked/);
  assert.equal(r.posts, 1);
});
test('watch validation rejects unsafe polling intervals, duplicate IDs and unsupported repositories', async () => {
  const { validateWatchConfig } = await import('../notifications.mjs');
  for (const value of [{ ...config, interval_seconds: 0 }, { ...config, tasks: [...config.tasks, ...config.tasks] }, { ...config, repository: 'unknown/repo' }]) assert.throws(() => validateWatchConfig(value));
});

test('checkpoint and observation are distinct from pending and confirmed delivery; failed retrieval never advances checkpoint', async (t) => {
  const fs = require('node:fs/promises');
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { pollNotifications } = await import('../notifications.mjs');
  const r = relay(); let value = 'OPEN';
  const options = { config, channel: 'channel', secret: generateSecretKey(), query: r.query, post: r.post,
    path: path.join(dir, 'state.json'), now: () => 100,
    githubRecord: (task, type) => type === 'runs' ? [] : type === 'pr' ? null : { ...records(task, type), state: value } };
  const read = async () => JSON.parse(await fs.readFile(options.path, 'utf8'));
  await pollNotifications(options);
  const baseline = await read();
  assert.equal(baseline.checkpoint.sequence, 1);
  assert.deepEqual(baseline.deliveries, {});
  await assert.rejects(pollNotifications({ ...options, githubRecord: async () => { throw new Error('GitHub unavailable'); } }), /unavailable/);
  assert.deepEqual(await read(), baseline);
  value = 'CLOSED';
  await assert.rejects(pollNotifications({ ...options, post: async () => { throw new Error('offline'); } }), /offline/);
  const failed = await read(), event = failed.pending[0];
  assert.equal(failed.checkpoint.sequence, 2);
  const observation = failed.observations[failed.deliveries[event.id].observationId];
  assert.equal(observation.status, 'observed');
  assert.equal(observation.sourceKey, 'P002:issue');
  assert.equal(observation.notificationEventId, event.id);
  assert.equal(failed.deliveries[event.id].status, 'pending');
  assert.equal(failed.deliveries[event.id].attempts, 1);
  assert.equal(failed.deliveries[event.id].confirmationEventId, undefined);
  await pollNotifications(options);
  const confirmed = (await read()).deliveries[event.id];
  assert.equal(confirmed.status, 'delivery_confirmed');
  assert.equal(confirmed.confirmationEventId, event.id);
  assert.equal(confirmed.attempts, 2);
  // Repeated transitions within the same clock second have separate identities.
  value = 'OPEN'; await pollNotifications(options);
  value = 'CLOSED'; await pollNotifications(options);
  assert.equal(new Set(Object.keys((await read()).observations)).size, 3);
  assert.equal(r.posts, 3);
});

test('ambiguous acceptance and invisible readback retain pending; recovery replays identical event and relies on relay ID dedup', async (t) => {
  const fs = require('node:fs/promises');
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { pollNotifications } = await import('../notifications.mjs');
  const r = relay(); let value = 'OPEN';
  const options = { config, channel: 'channel', secret: generateSecretKey(), query: r.query, post: r.post,
    path: path.join(dir, 'state.json'),
    githubRecord: (task, type) => type === 'runs' ? [] : type === 'pr' ? null : { ...records(task, type), state: value } };
  const read = async () => JSON.parse(await fs.readFile(options.path, 'utf8'));
  await pollNotifications(options); value = 'CLOSED';
  await assert.rejects(pollNotifications({ ...options, query: async () => [],
    post: async (...args) => { await r.post(...args); return {}; } }), /acceptance unknown/);
  const signed = (await read()).pending[0];
  assert.equal((await read()).deliveries[signed.id].status, 'pending');
  await assert.rejects(pollNotifications({ ...options, query: async () => [] }), /readback missing/);
  assert.deepEqual((await read()).pending[0], signed);
  assert.equal(r.posts, 2); // Two POST attempts are possible under ambiguous visibility.
  assert.equal(r.events.size, 1); // Identity-aware relay stores the exact event once.
  await pollNotifications(options);
  assert.equal(r.posts, 2);
  assert.equal((await read()).deliveries[signed.id].status, 'delivery_confirmed');
  assert.equal((await read()).pending.length, 0);
});

test('new Windows Node process recovers pending and suppresses confirmed delivery across another restart', async (t) => {
  const fs = require('node:fs/promises');
  const { pathToFileURL } = require('node:url');
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { pollNotifications } = await import('../notifications.mjs');
  const secret = generateSecretKey(), r = relay(); let value = 'OPEN';
  const options = { config, channel: 'channel', secret, query: r.query, post: r.post,
    path: path.join(dir, 'state.json'),
    githubRecord: (task, type) => type === 'runs' ? [] : type === 'pr' ? null : { ...records(task, type), state: value } };
  await pollNotifications(options); value = 'CLOSED';
  await assert.rejects(pollNotifications({ ...options, post: async () => { throw new Error('offline'); } }));
  const input = path.join(dir, 'child.json'), output = path.join(dir, 'relay.json');
  await fs.writeFile(input, JSON.stringify({ config, secret: Array.from(secret), path: options.path, output,
    issue: { ...records({ ...config.tasks[0], repository: config.repository }, 'issue'), state: value } }));
  const code = `import { readFile, writeFile } from 'node:fs/promises';
    import { pollNotifications } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../notifications.mjs')).href)};
    const data = JSON.parse(await readFile(process.argv[1], 'utf8'));
    let relay; try { relay = JSON.parse(await readFile(data.output, 'utf8')); } catch { relay = { posts: 0, events: [] }; }
    await pollNotifications({ config: data.config, channel: 'channel', secret: Uint8Array.from(data.secret), path: data.path,
      githubRecord: async (_, type) => type === 'issue' ? data.issue : type === 'runs' ? [] : null,
      query: async ({ ids }) => relay.events.filter(e => ids.includes(e.id)),
      post: async (_, event) => { relay.posts++; relay.events.push(event); await writeFile(data.output, JSON.stringify(relay)); return { accepted: true }; } });`;
  const run = () => execFile(process.execPath, ['--input-type=module', '-e', code, input], { windowsHide: true, timeout: 30000 });
  await run(); await run();
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).posts, 1);
  const state = JSON.parse(await fs.readFile(options.path, 'utf8'));
  assert.equal(state.pending.length, 0);
  assert.equal(Object.values(state.deliveries)[0].status, 'delivery_confirmed');
});
