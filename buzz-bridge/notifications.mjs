import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, verifyEvent, getPublicKey } from 'nostr-tools';

export function validateWatchConfig(value) {
  if (value?.repository !== 'seongwwww/sumtech' || !['test', 'agent-reports'].includes(value.channel)
    || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 100) throw new Error('Invalid GitHub watch configuration.');
  const interval = value.interval_seconds ?? 60;
  if (!Number.isInteger(interval) || interval < 30 || interval > 3600) throw new Error('Polling interval must be 30–3600 seconds.');
  const ids = new Set();
  for (const task of value.tasks) {
    if (!/^P\d{3,6}$/.test(task.task_id) || ids.has(task.task_id)) throw new Error('Invalid or duplicate watched task.');
    ids.add(task.task_id);
    for (const key of ['issue', 'pull_request']) if (task[key] != null && (!Number.isSafeInteger(task[key]) || task[key] < 1)) throw new Error('Invalid watched issue/PR.');
  }
  if (value.discover_new !== undefined && typeof value.discover_new !== 'boolean') throw new Error('discover_new must be boolean.');
  return { repository: value.repository, channel: value.channel, interval_seconds: interval, discover_new: value.discover_new ?? false,
    tasks: value.tasks.map(({ task_id, issue = null, pull_request = null }) => ({ task_id, issue, pull_request })) };
}
export async function readWatchConfig(args) {
  const index = args.indexOf('--watch-config');
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--watch-config requires a JSON file.');
  return validateWatchConfig(JSON.parse(await readFile(args[index + 1], 'utf8')));
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temp, path);
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const tag = (event, key) => event.tags.find((t) => t[0] === key)?.[1];
function checks(pr) {
  return (pr?.statusCheckRollup ?? []).map((check) => ({ name: check.name ?? check.context,
    status: check.status ?? check.state, conclusion: check.conclusion ?? null,
    url: check.detailsUrl ?? check.targetUrl ?? null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
// Checkpoint means observed, never delivered. Retain an audit record after the
// outbox is drained; an exact signed-event readback is the delivery boundary.
export async function pollNotifications({ config, channel, secret, query, post, path, githubRecord,
  authority = async () => {}, rootForTask = async () => null, now = () => Math.floor(Date.now() / 1000) }) {
  config = validateWatchConfig(config);
  const agent = getPublicKey(secret);
  const fingerprint = hash({ config, channel, agent });
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || state.fingerprint !== fingerprint || !Array.isArray(state.pending)
      || !state.snapshots || typeof state.snapshots !== 'object') throw new Error('Notification state/config mismatch; retain state for review.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state) {
    // Extend existing v1 state without dropping its exact signed outbox events.
    state.checkpoint ??= { sequence: 0, observedAt: null, snapshotDigest: hash(state.snapshots) };
    state.observations ??= {};
    state.deliveries ??= {};
    for (const event of state.pending) state.deliveries[event.id] ??= {
      eventId: event.id, observationId: null, status: 'pending', attempts: 0,
      recoveryPolicy: 'query-then-replay-identical-signed-event',
    };
  }
  const deliver = async () => {
    while (state.pending.length) {
      const event = state.pending[0];
      if (!verifyEvent(event) || event.pubkey !== agent || event.kind !== 9 || tag(event, 'h') !== channel) throw new Error('Invalid stored notification.');
      const delivery = state.deliveries[event.id];
      await authority();
      const confirmed = async () => (await query({ ids: [event.id], limit: 1 })).some((e) => e.id === event.id && verifyEvent(e));
      try {
        if (!await confirmed()) {
          delivery.attempts++;
          delivery.lastAttemptAt = now();
          await save(path, state);
          const receipt = await post('/events', event);
          if (!(receipt?.accepted === true || (Array.isArray(receipt) && receipt[0] === 'OK' && receipt[1] === event.id && receipt[2] === true))) throw new Error('Notification acceptance unknown; exact event retained.');
          if (!await confirmed()) throw new Error('Notification readback missing; exact event retained.');
        }
      } catch (error) {
        // Do not persist transport error text, which can contain credentials.
        delivery.retryState = 'awaiting-reconciliation';
        await save(path, state);
        throw error;
      }
      delivery.status = 'delivery_confirmed';
      delivery.confirmedAt = now();
      delivery.confirmationEventId = event.id;
      delivery.retryState = null;
      state.pending.shift();
      await save(path, state);
    }
  };
  if (state) await deliver();
  const snapshots = {};
  for (const task of config.tasks) {
    const full = { ...task, repository: config.repository };
    const issue = await githubRecord(full, 'issue'), pr = await githubRecord(full, 'pr');
    for (const [kind, record] of [['issue', issue], ['pr', pr]]) if (record) snapshots[`${task.task_id}:${kind}`] = {
      task_id: task.task_id, kind, number: record.number, title: record.title, state: record.state,
      updated_at: record.updatedAt ?? null, state_reason: record.stateReason ?? null, merged_at: record.mergedAt ?? null, url: record.url,
    };
    if (pr) snapshots[`${task.task_id}:review`] = { task_id: task.task_id, kind: 'review', url: pr.url,
      decision: pr.reviewDecision ?? null, reviews: (pr.reviews ?? []).map((review) => ({ id: review.id, state: review.state, submitted_at: review.submittedAt, author: review.author?.login })) };
    if (pr) snapshots[`${task.task_id}:ci`] = { task_id: task.task_id, kind: 'ci', url: pr.url, checks: checks(pr) };
  }
  const runs = await githubRecord({ repository: config.repository }, 'runs');
  if (config.discover_new) {
    for (const type of ['issues', 'prs']) {
      const kind = type === 'issues' ? 'issue' : 'pr';
      for (const item of await githubRecord({ repository: config.repository }, type)) {
        if (config.tasks.some((task) => (kind === 'issue' ? task.issue : task.pull_request) === item.number)) continue;
        const taskId = item.title.match(/\bP\d{3,6}\b/i)?.[0]?.toUpperCase() ?? null;
        snapshots[`discovered:${kind}:${item.number}`] = { kind, task_id: taskId,
          number: item.number, title: item.title, state: item.state, updated_at: item.updatedAt, url: item.url };
      }
    }
  }
  for (const run of runs ?? []) snapshots[`run:${run.databaseId}`] = { kind: 'workflow_run', id: run.databaseId,
    name: run.workflowName, status: run.status, conclusion: run.conclusion, url: run.url };
  if (!state) {
    state = { version: 1, fingerprint, snapshots, pending: [], observations: {}, deliveries: {},
      checkpoint: { sequence: 1, observedAt: now(), snapshotDigest: hash(snapshots) } };
    await save(path, state);
    return { baseline: true, queued: 0 };
  }
  const sequence = state.checkpoint.sequence + 1;
  for (const [key, current] of Object.entries(snapshots)) {
    if (hash(current) === hash(state.snapshots[key])) continue;
    const observationId = hash({ fingerprint, key, sequence, current });
    const tags = [['h', channel], ['github-observation', observationId]];
    const root = current.task_id ? await rootForTask(current.task_id) : null;
    if (root) {
      const event = (await query({ ids: [root], limit: 1 })).find((e) => e.id === root && e.kind === 9 && tag(e, 'h') === channel && verifyEvent(e));
      if (!event) throw new Error('Notification task root is not readable in this channel.');
      tags.push(['e', root, '', 'root'], ['e', root, '', 'reply']);
    }
    const event = finalizeEvent({ kind: 9, created_at: now(), tags,
      content: `GitHub 변경 알림 (${current.task_id ?? config.repository})\n${JSON.stringify({ previous: state.snapshots[key] ?? null, current }, null, 2)}` }, secret);
    state.observations[observationId] = { observationId, sourceKey: key, checkpoint: sequence,
      observedAt: now(), status: 'observed', previous: state.snapshots[key] ?? null, current,
      notificationEventId: event.id };
    state.deliveries[event.id] = { eventId: event.id, observationId, status: 'pending', attempts: 0,
      recoveryPolicy: 'query-then-replay-identical-signed-event' };
    state.pending.push(event);
  }
  const queued = state.pending.length;
  state.snapshots = snapshots;
  state.checkpoint = { sequence, observedAt: now(), snapshotDigest: hash(snapshots) };
  await save(path, state);
  await deliver();
  return { baseline: false, queued };
}
