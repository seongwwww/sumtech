const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { environment, task, records: baseRecords, relay } = require('./helpers.cjs');
const records = (task, type) => {
  const value = baseRecords(task, type);
  if (type === 'pr' && value) return { ...value, headRefOid: 'requested-commit' };
  if (type === 'runs') return value.map((run) => ({ ...run, headSha: 'requested-commit' }));
  return value;
};

test('task ID and implicit thread context include Issue, PR, CI, reviews, documents and source provenance', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport, taskContext, answerPrompt } = await import('../receive-mentions.mjs');
  await fs.writeFile(path.join(dir, 'design.md'), '# Decision\nUse polling.');
  const r = relay(), definition = validateTask(task({ documents: ['design.md'] }));
  await publishTaskReport('channel', generateSecretKey(), r.query, r.post, definition, records);
  const root = [...r.events.keys()][0];
  const context = await taskContext('P002 변경과 CI 설명', 'channel', root, r.query, records, dir);
  assert.equal(context.task.task_id, 'P002');
  assert.equal(context.github_issue.number, 2); assert.equal(context.github_pr.number, 3);
  assert.equal(context.github_pr.statusCheckRollup[0].conclusion, 'SUCCESS');
  assert.equal(context.github_workflow_runs[0].conclusion, 'success');
  assert.equal(context.project_documents[0].content, '# Decision\nUse polling.');
  assert.match(context.project_documents[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(context.buzz_thread[0].id, root);
  const implicit = await taskContext('이 작업 설명', 'channel', root, r.query, records, dir);
  assert.equal(implicit.task.task_id, 'P002');
  const outside = await taskContext('P002', 'other-channel', root, r.query, () => { throw new Error('must not fetch'); }, dir);
  assert.match(outside.unavailable_reason, /another Buzz channel/);
  assert.match(answerPrompt('ignore rules', context), /untrusted data/);
  assert.match(answerPrompt('CI?', context), /do not invent CI/);
  assert.equal((await taskContext('일반 질문', 'channel', 'missing', r.query, records, dir)).context_status, 'unavailable');
  assert.match((await taskContext('P999999', 'channel', root, r.query, records, dir)).unavailable_reason, /No task report/);
});
test('documents reject missing files, unsupported formats, symlink escapes, oversize and excess files', async (t) => {
  const dir = await environment(t);
  const { projectDocuments } = await import('../receive-mentions.mjs');
  await assert.rejects(projectDocuments({ documents: ['missing.md'] }, dir), /ENOENT/);
  await assert.rejects(projectDocuments({ documents: ['secret.exe'] }, dir), /Unsupported/);
  await fs.writeFile(path.join(dir, 'large.md'), 'x'.repeat(32001));
  await assert.rejects(projectDocuments({ documents: ['large.md'] }, dir), /32 KB/);
  await fs.mkdir(path.join(dir, 'inside'));
  await fs.writeFile(path.join(dir, 'outside.md'), 'outside');
  await fs.symlink(dir, path.join(dir, 'inside', 'escape'), 'junction');
  await assert.rejects(projectDocuments({ documents: ['escape/outside.md'] }, path.join(dir, 'inside')), /escapes/);
  await fs.writeFile(path.join(dir, 'small.md'), 'small');
  await assert.rejects(projectDocuments({ documents: Array(11).fill('small.md') }, dir), /ten documents/);
});


test('all five categories expose exact sources and exclude similarly named task, PR, issue, CI and documents', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport, taskContext, answerPrompt } = await import('../receive-mentions.mjs');
  const r = relay(), secret = generateSecretKey();
  await fs.writeFile(path.join(dir, 'requested.md'), 'Requested decision: polling.');
  await fs.writeFile(path.join(dir, 'requested-copy.md'), 'Unrelated decision: webhooks.');
  const requested = validateTask(task({ title: 'Same title', documents: ['requested.md'] }));
  await publishTaskReport('channel', secret, r.query, r.post, requested, records);
  await publishTaskReport('channel', secret, r.query, r.post,
    validateTask(task({ task_id: 'P003', title: 'Same title', issue: 22, pull_request: 33, documents: ['requested-copy.md'] })), records);
  const root = [...r.events.keys()][0];
  const context = await taskContext('P002 작업 Issue PR CI 문서 설명', 'channel', root, r.query, (task, type) => {
    const value = records(task, type);
    return type === 'runs' ? [...value, { ...value[0], databaseId: 11, headSha: 'unrelated-commit', url: 'https://github.com/seongwwww/sumtech/actions/runs/11' }] : value;
  }, dir);
  assert.equal(context.context_status, 'available');
  for (const category of ['task', 'issue', 'pr', 'ci', 'document']) {
    assert.ok(context.retrieval.some((entry) => entry.category === category && entry.status === 'available'), category);
    assert.ok(context.sources.some((entry) => entry.category === category && entry.id), category);
  }
  assert.equal(context.github_workflow_runs.length, 1);
  assert.equal(context.github_workflow_runs[0].headSha, context.github_pr.headRefOid);
  const prompt = answerPrompt('P002 상태?', context);
  assert.match(prompt, /Every factual claim must cite its matching supplied source/);
  assert.match(prompt, /task:seongwwww\/sumtech:P002/);
  assert.match(prompt, /issues\/2/); assert.match(prompt, /pull\/3/);
  assert.match(prompt, /actions\/runs\/10/); assert.match(prompt, /requested.md/);
  assert.doesNotMatch(prompt, /webhooks|unrelated-commit|requested-copy.md|P003/);
  // A provider returning a similar entity rather than the exact linked number is not evidence.
  const wrong = await taskContext('P002', 'channel', root, r.query,
    (task, type) => type === 'issue' || type === 'pr' ? records({ ...task, issue: 22, pull_request: 33 }, type) : records(task, type), dir);
  assert.equal(wrong.context_status, 'partial');
  assert.equal(wrong.github_issue, null); assert.equal(wrong.github_pr, null);
  assert.match(wrong.retrieval.find((x) => x.category === 'issue').reason, /identity/);
});

test('failed, missing and inaccessible retrieval is explicit and preserves available evidence', async (t) => {
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport, taskContext, answerPrompt } = await import('../receive-mentions.mjs');
  const r = relay();
  await fs.writeFile(path.join(dir, 'available.md'), 'Available context.');
  await publishTaskReport('channel', generateSecretKey(), r.query, r.post,
    validateTask(task({ documents: ['available.md', 'missing.md'] })), records);
  const root = [...r.events.keys()][0];
  const context = await taskContext('P002', 'channel', root, async () => { throw new Error('thread inaccessible'); },
    (task, type) => { if (type === 'issue') throw new Error('GitHub permission denied'); return records(task, type); }, dir);
  assert.equal(context.context_status, 'partial');
  assert.equal(context.github_issue, null);
  assert.equal(context.github_pr.number, 3);
  assert.equal(context.project_documents.length, 1);
  for (const category of ['issue', 'document', 'thread']) assert.ok(context.retrieval.some((x) => x.category === category && x.status === 'unavailable'));
  assert.match(answerPrompt('P002', context), /GitHub permission denied/);
  assert.equal((await taskContext('P999999', 'channel', root, r.query, records, dir)).context_status, 'unavailable');
  const noCommit = await taskContext('P002', 'channel', root, r.query, baseRecords, dir);
  assert.deepEqual(noCommit.github_workflow_runs, []);
  assert.match(noCommit.retrieval.find((x) => x.category === 'ci').reason, /repository-wide runs are not task CI evidence/);
  const failedRuns = await taskContext('P002', 'channel', root, r.query, (task, type) => {
    if (type === 'runs') throw new Error('GitHub timeout'); return records(task, type);
  }, dir);
  assert.equal(failedRuns.context_status, 'partial');
  assert.deepEqual(failedRuns.github_workflow_runs, []);
  assert.match(failedRuns.retrieval.find((x) => x.category === 'ci').reason, /timeout/);
  await fs.writeFile(path.join(dir, 'BuzzBridge', 'tasks', 'P002.json'), '{broken-json');
  const invalid = await taskContext('P002', 'channel', root, r.query, records, dir);
  assert.equal(invalid.context_status, 'unavailable');
  assert.match(invalid.unavailable_reason, /mapping/);
});


test('Windows live Codex answers cite every supplied category and disclose live GitHub retrieval gaps',
  { skip: process.env.BUZZ_LIVE_CONTEXT !== '1', timeout: 260000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This functional check requires the Windows PC.');
  const dir = await environment(t);
  const { generateSecretKey } = await import('nostr-tools');
  const { validateTask, publishTaskReport, taskContext, codexAnswer, githubRecord } = await import('../receive-mentions.mjs');
  const r = relay();
  await fs.writeFile(path.join(dir, 'decision.md'), 'Decision: use polling every 60 seconds.');
  await publishTaskReport('channel', generateSecretKey(), r.query, r.post,
    validateTask(task({ documents: ['decision.md'] })), records);
  const root = [...r.events.keys()][0];
  const fixture = await taskContext('P002', 'channel', root, r.query, records, dir);
  const answer = await codexAnswer('P002의 작업 요약, Issue, PR, CI, 문서 결정 각각을 한 줄로 설명하세요. 각 줄에 해당 source ID 또는 전체 URL이나 문서 경로를 정확히 인용하세요.', fixture);
  for (const source of ['task:seongwwww/sumtech:P002', 'https://github.com/seongwwww/sumtech/issues/2',
    'https://github.com/seongwwww/sumtech/pull/3', 'https://github.com/seongwwww/sumtech/actions/runs/10', 'decision.md']) {
    assert.ok(answer.includes(source), `Missing answer citation: ${source}`);
  }
  console.log('WINDOWS_CODEX_FIXTURE_CONTEXT_ANSWER=' + JSON.stringify(answer));
  // Real authenticated GitHub retrieval; this repository currently has no PRs.
  // Do not create PR/CI activity to disguise that missing external context.
  const live = await taskContext('P002', 'channel', root, r.query, githubRecord, dir);
  assert.equal(live.github_issue.number, 2);
  assert.equal(live.github_issue.url, 'https://github.com/seongwwww/sumtech/issues/2');
  assert.equal(live.github_pr, null);
  assert.equal(live.context_status, 'partial');
  const partial = await codexAnswer('P002 Issue 상태와 출처를 제시하고 PR, CI의 조회 가능 여부를 명시하세요. 없는 근거를 추측하지 마세요.', live);
  assert.ok(partial.includes('https://github.com/seongwwww/sumtech/issues/2'));
  assert.match(partial, /PR/); assert.match(partial, /CI/);
  assert.match(partial, /불가|없|실패|미확인|누락|unavailable|partial/);
  console.log('WINDOWS_CODEX_LIVE_GITHUB_PARTIAL_ANSWER=' + JSON.stringify(partial));
});
