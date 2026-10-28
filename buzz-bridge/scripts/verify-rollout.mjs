// AC5: every write, install, log and fixture lives outside the workspace.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir, hostname, release } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { packSource } from './pack-source.mjs';
import { windowsPowerShellEnv } from '../windows-env.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'buzz-ac5-'));
const evidence = { ac: 5, at: new Date().toISOString(), scratch,
  environment: { platform: process.platform, hostname: hostname(), windows: release(), node: process.version },
  scope: 'One Windows PC; ten prepared identities, not ten verified PCs',
  planned_checks: ['manifest preflight', 'portable clean archive', 'scratch npm ci', 'ten DPAPI identities',
    'Windows dual-process fixture isolation', 'two fresh live Buzz listener configurations', 'stop one while other remains live'],
  commands: [], developers: [], limitations: [],
  seedProvenance: { corrected: 'buzz-bridge-delivery-corrected-v1', predecessor: 'seed_d209e78e5d5f',
    predecessor_digest_before: null, predecessor_digest_after: null,
    reason: 'Predecessor absent from workspace; never executed or modified.' } };
async function inventory(folder = workspace) {
  const files = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const full = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(full));
    else if (entry.isFile()) files[relative(workspace, full).replaceAll('\\', '/')] =
      createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return files;
}
const before = await inventory();
const source = join(scratch, 'clean source', 'buzz-bridge');
function command(executable, args, { env = process.env, cwd = source, classification = 'local', timeout = 120000 } = {}) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout });
  const record = { command: [executable, ...args], cwd, classification, exit: result.status,
    output: result.stdout ?? '', error: result.stderr ?? '', launchError: result.error?.message ?? null };
  evidence.commands.push(record);
  return record;
}
const ps = (name, developer, extra = []) => command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', join(source, 'scripts', `${name}.ps1`), '-DataDirectory', developer.data, ...extra], { classification: 'live Buzz', timeout: 30000 });
const wait = ms => new Promise(done => setTimeout(done, ms));
async function ready(developer) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const stdout = await readFile(join(developer.data, 'BuzzBridge/runner/stdout.log'), 'utf8').catch(() => '');
    const stderr = await readFile(join(developer.data, 'BuzzBridge/runner/stderr.log'), 'utf8').catch(() => '');
    if (stdout.includes('LISTENING channels=')) return { ready: true, stdout, stderr };
    if (stderr.trim()) return { ready: false, stdout, stderr };
    await wait(500);
  }
  return { ready: false, reason: 'No LISTENING service-readiness confirmation within 20 seconds' };
}
try {
  assert.equal(process.platform, 'win32', 'Windows verification required');
  assert.ok(isAbsolute(relative(workspace, scratch)) || relative(workspace, scratch).startsWith('..'));
  const seed = JSON.parse(await readFile(join(workspace, 'buzz-bridge/delivery.seed.json'), 'utf8'));
  evidence.artifactManifest = seed.expected_artifacts.map(file => ({ file, declared: true, present: !!before[file] }));
  assert.ok(evidence.artifactManifest.every(file => file.present));
  const archive = join(scratch, 'rollout.zip');
  evidence.archive = await packSource(archive);
  await mkdir(join(scratch, 'clean source'));
  const extract = command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:BUZZ_ROLLOUT_ARCHIVE -DestinationPath $env:BUZZ_ROLLOUT_DEST'],
  { cwd: scratch, env: { ...windowsPowerShellEnv(), BUZZ_ROLLOUT_ARCHIVE: archive, BUZZ_ROLLOUT_DEST: join(scratch, 'clean source') } });
  assert.equal(extract.exit, 0);
  for (const executable of ['node.exe', 'pwsh.exe', 'gh.exe']) {
    assert.equal(command(executable, ['--version']).exit, 0, `${executable} prerequisite unavailable`);
  }
  const env = { ...process.env, npm_config_cache: join(scratch, 'npm cache'), LOCALAPPDATA: join(scratch, 'install state') };
  const install = command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'npm.cmd ci; exit $LASTEXITCODE'], { env });
  assert.equal(install.exit, 0, 'Scratch npm ci failed');
  const tests = command(process.execPath, ['--test', 'test/rollout-kit.test.cjs'], { env, classification: 'Windows real DPAPI and fixture workers', timeout: 240000 });
  assert.equal(tests.exit, 0, 'Rollout tests failed');
  for (const name of ['Agent-Rollout1', 'Agent-Rollout2']) {
    const data = join(scratch, name), config = join(data, 'config.json');
    const developer = { name, data, config }; evidence.developers.push(developer);
    const setup = command(process.execPath, ['scripts/setup-agent.mjs', '--name', name, '--caller', 'b'.repeat(64)],
      { env: { ...process.env, LOCALAPPDATA: data, BUZZ_BRIDGE_CONFIG: config } });
    assert.equal(setup.exit, 0);
    developer.publicKey = JSON.parse(await readFile(join(data, 'BuzzBridge', `${name.toLowerCase()}.identity.json`), 'utf8')).public_key;
    developer.start = ps('run', developer, ['-Config', config, '-Agent', 'codex']);
    developer.readiness = await ready(developer);
    developer.status = ps('status', developer);
    if (!developer.readiness.ready) evidence.limitations.push(`${name}: live Buzz membership/channel access or network prerequisite unavailable; see readiness diagnostics. No service success claimed.`);
  }
  const [first, second] = evidence.developers;
  first.stop = ps('stop', first); first.afterStop = ps('status', first);
  second.afterOtherStopped = ps('status', second);
  const secondReadiness = await ready(second);
  evidence.liveIsolation = first.readiness.ready && second.readiness.ready && secondReadiness.ready &&
    first.stop.exit === 0 && /STOPPED/.test(first.afterStop.output) && /RUNNING/.test(second.afterOtherStopped.output);
  second.stop = ps('stop', second); second.afterStop = ps('status', second);
  evidence.outcome = evidence.liveIsolation && second.stop.exit === 0 && /STOPPED/.test(second.afterStop.output)
    ? 'passed' : 'external_verification_blocked';
} catch (error) {
  evidence.outcome = 'failed'; evidence.failure = error.message;
} finally {
  for (const developer of evidence.developers) ps('stop', developer);
  const after = await inventory();
  evidence.workspace_before = before; evidence.workspace_after = after;
  evidence.workspace_unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!evidence.workspace_unchanged) evidence.outcome = 'failed';
  await writeFile(join(scratch, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: join(scratch, 'evidence.json'), outcome: evidence.outcome,
    workspace_unchanged: evidence.workspace_unchanged, limitations: evidence.limitations }));
  process.exitCode = evidence.outcome === 'passed' ? 0 : evidence.outcome === 'external_verification_blocked' ? 2 : 1;
}
