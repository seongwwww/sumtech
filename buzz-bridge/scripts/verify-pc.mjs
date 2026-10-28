import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, copyFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir, hostname, release } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import assert from 'node:assert/strict';
import { settings } from '../settings.mjs';
import { codexExecutable } from '../receive-mentions.mjs';
import { claudeExecutable } from '../claude.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url)), workspace = resolve(cwd, '..');
const directory = await mkdtemp(join(tmpdir(), 'buzz-ac4-'));
assert.ok(isAbsolute(relative(workspace, directory)) || relative(workspace, directory).startsWith('..'), 'Scratch must be outside workspace');
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function inventory(folder = workspace) {
  const files = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const full = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(full));
    else if (entry.isFile()) files[relative(workspace, full)] = hash(await readFile(full));
  }
  return files;
}
const receipt = { ac: 4, verified_at: new Date().toISOString(), scope: 'one Windows PC; no ten-PC verification',
  environment: { platform: process.platform, arch: process.arch, hostname: hostname(), windows: release(), node: process.version },
  scratch: directory, classification: 'live agents, GitHub and Buzz; controlled empty polling checkpoint; no synthetic GitHub responses',
  planned_checks: ['both native agent invocations', 'report/revision/readback/dedup per agent', 'grounded context per agent', 'GitHub polling with confirmed Buzz delivery per agent'],
  agents: [], limitations: [], seedProvenance: { execution_target: 'buzz-bridge-delivery-corrected-v1', immutable_predecessor: 'seed_d209e78e5d5f',
    predecessor_digest: 'Unavailable: predecessor not present in workspace; no execution or modification attempted.' } };
const before = await inventory(); receipt.workspace_before = before;
const seed = JSON.parse(await readFile(join(cwd, 'delivery.seed.json'), 'utf8'));
receipt.artifactManifest = seed.expected_artifacts.map((file) => ({ file, declared: true, present: Object.hasOwn(before, file.replaceAll('/', '\\')) }));
const state = join(directory, 'state'), identity = join(state, 'BuzzBridge', settings.identityPath.split(/[\\/]/).at(-1));
function command(args, env = process.env, executable = process.execPath) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 160000, windowsHide: true });
  // Private authentication diagnostics from stderr must not enter evidence.
  return { command: [executable, ...args], exit: result.status, signal: result.signal, output: result.stdout?.trim() ?? '',
    outcome: result.status === 0 ? 'passed' : 'failed', failure: result.status === 0 ? null : 'Command failed; private stderr omitted. Check CLI authentication locally.' };
}
try {
  assert.equal(process.platform, 'win32');
  await mkdir(join(state, 'BuzzBridge'), { recursive: true });
  await copyFile(settings.identityPath, identity);
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ agent_name: settings.agentName, agent_public_key: settings.agentPublicKey,
    owner_public_key: settings.ownerPublicKey, allowed_callers: settings.allowedCallers }));
  const env = { ...process.env, LOCALAPPDATA: state, BUZZ_BRIDGE_CONFIG: config };
  for (const backend of ['codex', 'claude']) {
    const agent = { selectedAgent: backend, checks: [], outcome: 'incomplete' }; receipt.agents.push(agent);
    const check = (args, validate = () => {}) => {
      const result = command(['receive-mentions.mjs', ...args, '--agent', backend], env); agent.checks.push(result);
      if (result.exit !== 0) throw new Error(`${args[0]} failed: CLI/service prerequisite unavailable`);
      validate(result.output); return result.output;
    };
    try {
      agent.executable = backend === 'codex' ? codexExecutable().cli : claudeExecutable();
      agent.version = command(['--version'], process.env, agent.executable); assert.equal(agent.version.exit, 0);
      const invocation = command(['receive-mentions.mjs', '--agent-check', '--agent', backend], env);
      agent.checks.push(invocation); agent.invocation = invocation.outcome;
      const reportId = `ac4-${backend}-${randomUUID()}`, reportFile = join(directory, `${backend}-report.json`);
      const report = { reportId, threadId: reportId, revisionId: 'v1', submissionKey: 's1', channel: 'test',
        payload: { purpose: 'AC4 live generic report', selectedAgent: backend, invocation: invocation.outcome } };
      await writeFile(reportFile, JSON.stringify(report));
      const first = check(['--report', reportFile], (out) => assert.match(out, /REPORT_CONFIRMED/));
      agent.reportRoot = first.match(/root_id=([a-f0-9]{64})/)[1];
      report.revisionId = 'v2'; report.submissionKey = 's2'; report.previousRevisionId = 'v1'; report.payload.revised = true;
      await writeFile(reportFile, JSON.stringify(report));
      check(['--report', reportFile], (out) => assert.ok(out.includes(`root_id=${agent.reportRoot}`)));
      check(['--report', reportFile]);
      const reportState = JSON.parse(await readFile(join(state, 'BuzzBridge', 'reports', `${hash(reportId)}.json`), 'utf8'));
      agent.reportRevisions = Object.values(reportState.revisions).map(({ event, status, revisionId }) => ({ eventId: event.id, status, revisionId, tags: event.tags }));
      assert.equal(agent.reportRevisions.length, 2);
      assert.ok(agent.reportRevisions.every((x) => x.status === 'delivery-confirmed'));
      let taskId;
      do { taskId = `P${randomInt(100000, 999999)}`; }
      while (await readFile(join(process.env.LOCALAPPDATA, 'BuzzBridge', 'tasks', `${taskId}.json`)).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; }));
      agent.taskId = taskId;
      const taskFile = join(directory, `${backend}-task.json`);
      await writeFile(taskFile, JSON.stringify({ task_id: taskId, repository: 'seongwwww/sumtech', channel: 'test',
        title: `AC4 ${backend} live context`, status: 'in_progress', summary: 'Live verification; external gaps recorded separately.',
        issue: 2, pull_request: null, changed_files: [], tests: { status: 'in_progress' }, documents: ['buzz-bridge/README.ko.md'] }));
      check(['--report', taskFile]);
      const watchFile = join(directory, `${backend}-watch.json`);
      await writeFile(watchFile, JSON.stringify({ repository: 'seongwwww/sumtech', channel: 'test', interval_seconds: 30, tasks: [{ task_id: taskId, issue: 2 }] }));
      const pollArgs = ['--watch-github', '--channels', 'test', '--watch-config', watchFile, '--once'];
      const notificationPath = join(state, 'BuzzBridge', 'github-notifications.json');
      await unlink(notificationPath).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      check(pollArgs);
      const baseline = JSON.parse(await readFile(notificationPath, 'utf8'));
      // Controlled replay of an existing real Issue; not a newly-created event.
      baseline.snapshots = {};
      await writeFile(notificationPath, JSON.stringify(baseline));
      check(pollArgs);
      const notified = JSON.parse(await readFile(notificationPath, 'utf8'));
      agent.notifications = { checkpoint: notified.checkpoint, observations: notified.observations, deliveries: notified.deliveries };
      assert.ok(Object.values(notified.deliveries).length > 0);
      assert.ok(Object.values(notified.deliveries).every((x) => x.status === 'delivery_confirmed' && x.confirmationEventId === x.eventId));
      check(pollArgs, (out) => assert.match(out, /"queued":0/));
      if (invocation.exit === 0) {
        check(['--context-check', taskId], (out) => {
          assert.match(out, /CONTEXT_ANSWER=/);
          assert.match(out.split('CONTEXT_ANSWER=')[1], /https:\/\/github.com\/seongwwww\/sumtech\/issues\/2/);
        });
        agent.outcome = 'passed';
      } else {
        agent.outcome = 'external_verification_blocked';
        agent.blocker = `${backend} actual invocation failed; successful invocation and grounded answer remain unverified. Restore CLI authentication locally.`;
      }
    } catch (error) { agent.outcome = 'external_verification_blocked'; agent.blocker = error.message; }
    console.log(`AGENT_VERIFICATION=${backend}:${agent.outcome}`);
  }
} catch (error) { receipt.limitations.push(error.message); }
finally {
  await unlink(identity).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  receipt.workspace_after = await inventory();
  receipt.workspace_unchanged = JSON.stringify(before) === JSON.stringify(receipt.workspace_after);
  receipt.inventory_exclusions = ['.git', 'node_modules'];
  receipt.outcome = receipt.agents.length === 2 && receipt.agents.every((x) => x.outcome === 'passed') && receipt.workspace_unchanged ? 'passed' : 'external_verification_blocked';
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`ONE_PC_VERIFICATION=${receipt.outcome} EVIDENCE=${join(directory, 'evidence.json')}`);
  process.exitCode = receipt.outcome === 'passed' ? 0 : 2;
}
