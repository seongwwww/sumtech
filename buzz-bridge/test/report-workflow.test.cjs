const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { environment, task, records, relay } = require('./helpers.cjs');

const envelope = (overrides = {}) => ({ reportId: 'release-report', threadId: 'release-thread', revisionId: 'r1',
  submissionKey: 'submit-1', previousRevisionId: null, payload: { arbitrary: { count: 2, checks: [true, null, '완료'] } }, ...overrides });
const key = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex');
const savedReport = async (dir, reportId = 'release-report') => JSON.parse(await fs.readFile(path.join(dir, 'BuzzBridge/reports', `${key(reportId)}.json`), 'utf8'));

test('explicit generic identities create a root, preserve revised thread, survive restart, and separate independent reports', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  const initial = validateTask(envelope());
  await publishTaskReport('channel', secret, r.query, r.post, initial);
  let state = await savedReport(dir);
  const root = state.rootEventId;
  assert.equal(r.posts, 1);
  assert.equal(state.reportId, initial.reportId);
  assert.equal(state.threadId, initial.threadId);
  assert.equal(state.headRevisionId, 'r1');
  assert.equal(state.revisions[key('r1')].status, 'delivery-confirmed');
  assert.deepEqual(state.revisions[key('r1')].payload, initial.payload);
  assert.equal(r.events.get(root).tags.filter((tag) => tag[0] === 'e').length, 0);
  assert.match(r.events.get(root).content, /"count":2/);
  const revised = envelope({ revisionId: 'r2', previousRevisionId: 'r1', submissionKey: 'submit-2', payload: { arbitrary: 'changed', extra: [1, 2] } });
  await publishTaskReport('channel', secret, r.query, r.post, revised);
  state = await savedReport(dir);
  const event = state.revisions[key('r2')].event;
  assert.equal(r.posts, 2);
  assert.equal(state.rootEventId, root);
  assert.equal(state.revisions[key('r2')].previousRevisionId, 'r1');
  assert.equal(state.revisions[key('r2')].status, 'delivery-confirmed');
  assert.equal(state.submissions[key('submit-2')].eventId, event.id);
  assert.ok(event.tags.some((tag) => tag[0] === 'e' && tag[1] === root && tag[3] === 'root'));
  assert.ok(event.tags.some((tag) => tag[0] === 'e' && tag[1] === root && tag[3] === 'reply'));
  assert.match(event.content, /changed/);

  // Start an actual new Node process, sharing only persisted state and the signing key.
  // No transport POST is allowed on replay, even for a previously accepted older revision.
  const moduleUrl = require('node:url').pathToFileURL(path.resolve(__dirname, '../receive-mentions.mjs')).href;
  const replay = `import { publishTaskReport } from ${JSON.stringify(moduleUrl)};
    const secret = Uint8Array.from(${JSON.stringify([...secret])});
    for (const report of ${JSON.stringify([initial, revised])}) {
      await publishTaskReport('channel', secret, async () => [], async () => { throw new Error('duplicate delivery'); }, report);
    }`;
  require('node:child_process').execFileSync(process.execPath, ['--input-type=module', '--eval', replay], { env: { ...process.env }, windowsHide: true });
  state = await savedReport(dir);
  assert.equal(state.headRevisionId, 'r2', 'old replay must not roll back the current revision');
  assert.equal(Object.keys(state.revisions).length, 2);
  await publishTaskReport('channel', secret, r.query, r.post, envelope({ reportId: 'independent', threadId: 'independent-thread' }));
  const independent = await savedReport(dir, 'independent');
  assert.equal(r.posts, 3);
  assert.notEqual(independent.rootEventId, root);
  assert.notEqual(independent.reportId, state.reportId);
  assert.equal(r.events.get(independent.rootEventId).tags.filter((tag) => tag[0] === 'e').length, 0);
});

test('identity conflicts, stale revision linkage, and thread reuse cannot create deliveries', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  await publishTaskReport('channel', secret, r.query, r.post, envelope());
  for (const bad of [
    envelope({ payload: { changed: true } }),
    envelope({ submissionKey: 'another', payload: { changed: true } }),
    envelope({ revisionId: 'r2', submissionKey: 'another', previousRevisionId: 'missing' }),
    envelope({ threadId: 'changed-thread' }),
    envelope({ reportId: 'another-report' }),
  ]) await assert.rejects(publishTaskReport('channel', secret, r.query, r.post, bad), /conflict|identity|current revision/);
  await assert.rejects(publishTaskReport('other-channel', secret, r.query, r.post, envelope()), /identity/);
  await assert.rejects(publishTaskReport('channel', generateSecretKey(), r.query, r.post, envelope()), /identity/);
  assert.equal(r.posts, 1);
  assert.equal((await savedReport(dir)).headRevisionId, 'r1');
});

test('generic report recovers lost response with the same persisted signed event and no second POST', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  await assert.rejects(publishTaskReport('channel', secret, r.query, async (...args) => {
    await r.post(...args); throw new Error('lost response');
  }, envelope()), /lost response/);
  const pending = await savedReport(dir);
  assert.equal(pending.revisions[key('r1')].status, 'pending');
  await assert.rejects(publishTaskReport('channel', secret, r.query, r.post,
    envelope({ revisionId: 'r2', submissionKey: 'submit-2', previousRevisionId: 'r1' })), /pending revision/);
  await publishTaskReport('channel', secret, r.query, r.post, envelope());
  const confirmed = await savedReport(dir);
  assert.equal(r.posts, 1);
  assert.equal(confirmed.rootEventId, pending.rootEventId);
  assert.equal(confirmed.revisions[key('r1')].status, 'delivery-confirmed');
});

test('generic JSON canonical identity includes non-rendered fields, supports scalar payloads, and rejects invalid data', async (t) => {
  await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { publishTaskReport, validateTask } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  await publishTaskReport('channel', secret, r.query, r.post, envelope({ payload: { b: 2, a: 1 } }));
  await publishTaskReport('channel', secret, r.query, r.post, envelope({ payload: { a: 1, b: 2 } }));
  await publishTaskReport('channel', secret, r.query, r.post, envelope({ submissionKey: 'alternate-key', payload: { a: 1, b: 2 } }));
  assert.equal(r.posts, 1, 'same revision and canonical payload share one delivery');
  for (const payload of [null, false, 42, 'text', [1, { nested: true }]]) {
    assert.deepEqual(validateTask(envelope({ payload })).payload, payload);
  }
  for (const bad of [envelope({ reportId: '../escape' }), envelope({ reportId: 42 }), envelope({ threadId: '' }), envelope({ revisionId: '' }),
    envelope({ submissionKey: '' }), envelope({ payload: undefined }), envelope({ payload: { missing: undefined } }),
    envelope({ payload: NaN }), envelope({ payload: 'x'.repeat(25000) })]) assert.throws(() => validateTask(bad));
});

test('unconfirmed delivery stays pending and retry sends the exact event, then deduplicates', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  await assert.rejects(publishTaskReport('channel', secret, async () => [], r.post, envelope()), /readback unavailable/);
  let state = await savedReport(dir);
  assert.equal(state.headRevisionId, null);
  assert.equal(state.revisions[key('r1')].status, 'pending');
  const original = state.revisions[key('r1')].event;
  r.events.clear(); // Controlled relay did not retain the accepted event.
  await publishTaskReport('channel', secret, r.query, r.post, envelope());
  state = await savedReport(dir);
  assert.equal(r.posts, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(r.events.get(original.id))), original);
  assert.equal(state.revisions[key('r1')].status, 'delivery-confirmed');
  await publishTaskReport('channel', secret, r.query, r.post, envelope());
  assert.equal(r.posts, 2);
});

test('a concurrent submission cannot race the root creation', async (t) => {
  await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const first = publishTaskReport('channel', secret, r.query, async (...args) => {
    started(); await gate; return r.post(...args);
  }, envelope());
  await ready;
  try { await assert.rejects(publishTaskReport('channel', secret, r.query, r.post, envelope()), /locked/); }
  finally { release(); await first; }
  assert.equal(r.posts, 1);
});

test('CLI validates and previews arbitrary JSON using a scratch input file', async (t) => {
  const dir = await environment(t);
  const input = path.join(dir, 'generic-report.json');
  await fs.writeFile(input, JSON.stringify(envelope()));
  const result = require('node:child_process').execFileSync(process.execPath,
    [path.resolve(__dirname, '../receive-mentions.mjs'), '--report', input, '--preview-report'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.match(result, /release-report/);
  assert.match(result, /release-thread/);
  assert.match(result, /"count":2/);
  await assert.rejects(fs.stat(path.join(dir, 'BuzzBridge/reports')), { code: 'ENOENT' });
});
test('generic reports: root, exact dedup after restart, revisions, task mapping and channel boundary', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay();
  const first = validateTask(task());
  await publishTaskReport('channel', secret, r.query, r.post, first, records);
  let mapping = JSON.parse(await fs.readFile(path.join(dir, 'BuzzBridge/tasks/P002.json')));
  const root = mapping.root_event_id;
  assert.equal(r.posts, 1);
  await publishTaskReport('channel', secret, r.query, r.post, first, records);
  assert.equal(r.posts, 1);
  const revision = validateTask(task({ status: 'completed', summary: '수정된 요약', tests: { status: 'passed', type: 'reported', command: 'npm test', evidence: 'developer reported' } }));
  await publishTaskReport('channel', secret, r.query, r.post, revision, records);
  assert.equal(r.posts, 2);
  const event = [...r.events.values()][1];
  assert.ok(event.tags.some((x) => x[0] === 'e' && x[1] === root && x[3] === 'root'));
  assert.match(event.content, /보고 값/);
  await publishTaskReport('channel', secret, r.query, r.post, revision, records);
  assert.equal(r.posts, 2);
  mapping = JSON.parse(await fs.readFile(path.join(dir, 'BuzzBridge/tasks/P002.json')));
  assert.equal(mapping.root_event_id, root);
  assert.equal(mapping.task_definition.status, 'completed');
  assert.equal(mapping.issue, 2); assert.equal(mapping.pull_request, 3);
  await assert.rejects(publishTaskReport('other-channel', secret, r.query, r.post, first, records), /another channel/);
});
test('ambiguous publication is recovered by readback without a duplicate POST', async (t) => {
  await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport } = await import('../receive-mentions.mjs');
  const secret = generateSecretKey(), r = relay(), definition = validateTask(task());
  await assert.rejects(publishTaskReport('channel', secret, r.query, async (...args) => { await r.post(...args); throw new Error('lost response'); }, definition, records));
  await publishTaskReport('channel', secret, r.query, r.post, definition, records);
  assert.equal(r.posts, 1);
});
test('report validation rejects traversal, wrong repository, malformed status and missing evidence shape', async () => {
  const { validateTask } = await import('../receive-mentions.mjs');
  for (const value of [task({ task_id: '../bad' }), task({ repository: 'other/repo' }), task({ status: 'fake' }), task({ issue: -1 }), task({ documents: ['../secret.md'] }), task({ tests: null })]) assert.throws(() => validateTask(value));
});
