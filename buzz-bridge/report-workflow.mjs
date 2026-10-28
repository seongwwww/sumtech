import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Sorting object keys makes JSON identity independent of property insertion order.
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('Report payload must contain only JSON values.');
}

export function validateReport(value) {
  for (const name of ['reportId', 'threadId', 'revisionId', 'submissionKey']) {
    if (typeof value?.[name] !== 'string' || !identity.test(value[name])) throw new Error(`Invalid report ${name}.`);
  }
  if (value.previousRevisionId != null && (typeof value.previousRevisionId !== 'string' || !identity.test(value.previousRevisionId))) throw new Error('Invalid previousRevisionId.');
  if (!Object.hasOwn(value, 'payload')) throw new Error('Report requires a JSON payload.');
  const report = { reportId: value.reportId, threadId: value.threadId, revisionId: value.revisionId,
    submissionKey: value.submissionKey, previousRevisionId: value.previousRevisionId ?? null,
    channel: value.channel ?? 'agent-reports', payload: JSON.parse(canonical(value.payload)) };
  if (!['test', 'agent-reports'].includes(report.channel)) throw new Error('Report channel must be test or agent-reports.');
  if (Buffer.byteLength(canonical(report)) > 24000) throw new Error('Report exceeds 24000 bytes.');
  return report;
}

export function renderGenericReport(value) {
  const report = validateReport(value);
  return `보고서: ${report.reportId}\n스레드: ${report.threadId}\n리비전: ${report.revisionId}\n이전 리비전: ${report.previousRevisionId ?? '없음'}\n\n${canonical(report.payload)}`;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

// The per-report lock also protects callers that invoke this API without the CLI.
export async function publishGenericReport(channel, secret, query, post, value) {
  const report = validateReport(value);
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for durable report state.');
  const directory = join(process.env.LOCALAPPDATA, 'BuzzBridge', 'reports');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${hash(report.reportId)}.json`);
  const lock = `${file}.lock`;
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Report is locked; inspect the owning process before recovery.'); throw error; }
  try {
    const author = getPublicKey(secret), payloadHash = hash(canonical(report.payload));
    const binding = hash(canonical({ threadId: report.threadId, revisionId: report.revisionId,
      previousRevisionId: report.previousRevisionId, payloadHash }));
    let state = await readJson(file);
    if (state && (state.version !== 1 || state.reportId !== report.reportId || state.threadId !== report.threadId
      || state.channelId !== channel || state.author !== author)) throw new Error('Report identity belongs to another thread, channel or author.');
    // A logical thread can belong to only one report, even when different reports race.
    const claim = join(directory, `thread-${hash(report.threadId)}.json`);
    try { await writeFile(claim, JSON.stringify({ reportId: report.reportId, channelId: channel, author }), { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(claim);
      if (owner.reportId !== report.reportId || owner.channelId !== channel || owner.author !== author) throw new Error('Thread identity already belongs to another report, channel or author.');
    }
    state ??= { version: 1, reportId: report.reportId, threadId: report.threadId, channelId: channel, author,
      rootEventId: null, headRevisionId: null, revisions: {}, submissions: {} };
    // Hash dictionary keys so arbitrary explicit identities cannot address prototypes.
    const submissionKey = hash(report.submissionKey), revisionKey = hash(report.revisionId);
    const submission = state.submissions[submissionKey];
    if (submission && submission.binding !== binding) throw new Error('Submission identity conflict: key reused for different content or revision.');
    let revision = state.revisions[revisionKey];
    if (revision && revision.binding !== binding) throw new Error('Revision identity conflict: revisions are immutable.');
    if (!revision) {
      if (Object.values(state.revisions).some((item) => item.status !== 'delivery-confirmed')) throw new Error('Recover the pending revision before creating another revision.');
      if (report.previousRevisionId !== state.headRevisionId) throw new Error('previousRevisionId must identify the current revision (null for the initial report).');
      const tags = [['h', channel], ['report', report.reportId], ['thread', report.threadId], ['revision', report.revisionId]];
      if (state.rootEventId) tags.push(['e', state.rootEventId, '', 'root'], ['e', state.rootEventId, '', 'reply']);
      const event = finalizeEvent({ kind: 9, created_at: Math.floor(Date.now() / 1000), tags, content: renderGenericReport(report) }, secret);
      revision = { revisionId: report.revisionId, previousRevisionId: report.previousRevisionId, payloadHash,
        payload: report.payload, binding, event, status: 'pending' };
      state.revisions[revisionKey] = revision;
      state.rootEventId ??= event.id;
    }
    state.submissions[submissionKey] = { submissionKey: report.submissionKey, revisionId: report.revisionId, binding, eventId: revision.event.id };
    await atomicJson(file, state);
    if (revision.status === 'delivery-confirmed') return state;
    const event = revision.event;
    if (!verifyEvent(event) || event.pubkey !== author || event.content !== renderGenericReport(report)) throw new Error('Saved report event failed integrity validation.');
    const confirmed = async () => (await query({ ids: [event.id], limit: 1 })).some((candidate) =>
      candidate.id === event.id && verifyEvent(candidate) && canonical(candidate) === canonical(event));
    // A lost HTTP response is resolved by readback before any further POST.
    if (!await confirmed()) {
      const receipt = await post('/events', event);
      if (!(receipt?.accepted === true || (Array.isArray(receipt) && receipt[0] === 'OK' && receipt[1] === event.id && receipt[2] === true))) {
        throw new Error('Report acceptance unknown; exact signed event retained.');
      }
      if (!await confirmed()) throw new Error('Report readback unavailable; exact signed event retained.');
    }
    revision.status = 'delivery-confirmed';
    revision.confirmedAt = new Date().toISOString();
    state.headRevisionId = report.revisionId;
    await atomicJson(file, state);
    return state;
  } finally { await rmdir(lock); }
}
