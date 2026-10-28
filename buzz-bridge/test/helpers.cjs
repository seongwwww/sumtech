const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
exports.environment = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buzz-test-'));
  const prior = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;
  t.after(async () => { process.env.LOCALAPPDATA = prior; await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
};
exports.task = (overrides = {}) => ({ task_id: 'P002', repository: 'seongwwww/sumtech', title: '작업', status: 'in_progress',
  summary: '요약', changed_files: ['src/a.js'], tests: { status: 'not_run' }, issue: 2, pull_request: 3,
  documents: [], ...overrides });
exports.records = (task, type) => type === 'runs' ? [{ databaseId: 10, workflowName: 'test', status: 'completed', conclusion: 'success', url: 'https://github.com/seongwwww/sumtech/actions/runs/10' }]
  : (type === 'issue' ? task.issue : task.pull_request) == null ? null : ({ number: type === 'issue' ? task.issue : task.pull_request,
    title: type, body: 'external untrusted text', state: 'OPEN',
    url: `https://github.com/${task.repository}/${type === 'issue' ? 'issues' : 'pull'}/${type === 'issue' ? task.issue : task.pull_request}`,
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.test/check' }], reviews: [] });
exports.relay = () => {
  const events = new Map(); let posts = 0;
  return { events, get posts() { return posts; },
    query: async (filter) => [...events.values()].filter((e) => (!filter.ids || filter.ids.includes(e.id))
      && (!filter['#h'] || filter['#h'].includes(e.tags.find((t) => t[0] === 'h')?.[1]))
      && (!filter['#e'] || e.tags.some((t) => t[0] === 'e' && filter['#e'].includes(t[1])))),
    post: async (url, event) => { assert.equal(url, '/events'); const { verifyEvent } = await import('nostr-tools'); assert.ok(verifyEvent(event)); posts++; events.set(event.id, event); return { accepted: true }; } };
};
