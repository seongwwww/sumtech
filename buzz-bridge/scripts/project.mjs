import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegistry, saveRegistry, validateProject, selectProject, stateDirectory, project } from '../projects.mjs';
import { windowsPowerShellEnv } from '../windows-env.mjs';

const script = (name) => fileURLToPath(new URL(name, import.meta.url));
function option(args, name, fallback) {
  const aliases = { '--agent': '-Agent', '--mode': '-Mode', '--watch-config': '-WatchConfig' };
  let i = args.indexOf(name);
  if (i < 0 && aliases[name]) i = args.findIndex((arg) => arg.toLowerCase() === aliases[name].toLowerCase());
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
  return args[i + 1];
}
export function managedArgs(command, args = [], selected = project) {
  if (!['start', 'status', 'stop'].includes(command)) throw new Error('Invalid lifecycle command.');
  const result = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script(command === 'start' ? 'run.ps1' : `${command}.ps1`)];
  if (selected.name !== 'legacy') result.push('-StateDirectory', join(stateDirectory(), 'runner'));
  if (selected.name === 'legacy') {
    const legacyArgs = [...args];
    if (legacyArgs[0] === command) legacyArgs.shift();
    const index = legacyArgs.indexOf('--project'); if (index >= 0) legacyArgs.splice(index, 2);
    if (!legacyArgs.some((arg) => arg.startsWith('--'))) return [...result, ...legacyArgs];
  }
  if (command === 'start') {
    result.push('-Agent', option(args, '--agent', 'codex'), '-Mode', option(args, '--mode', 'listen'));
    const watch = option(args, '--watch-config', selected.watch_config);
    if (watch) result.push('-WatchConfig', resolve(watch));
  }
  return result;
}
export function lifecycle(command, args = []) {
  if (project.name !== 'legacy' && command === 'start' && (!project.relay_signer || !project.owner_public_key || !project.channel_ids)) throw new Error('Run project connect --project NAME first; community/channel membership approval is required.');
  const env = windowsPowerShellEnv();
  console.log(`PROJECT=${project.name} REPOSITORY=${project.repository} REPORT_CHANNEL=${project.report_channel}`);
  if (project.name !== 'legacy') env.BUZZ_PROJECT_SNAPSHOT = JSON.stringify(project);
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), managedArgs(command, args), { env, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
export function main(args = process.argv.slice(2)) {
  const [command, name] = args;
  if (['start', 'status', 'stop'].includes(command)) return lifecycle(command, args);
  const registry = readRegistry();
  if (command === 'list') { console.log(JSON.stringify({ selected: registry.selected, projects: ['legacy', ...Object.keys(registry.projects)] }, null, 2)); return; }
  if (command === 'add') {
    if (Object.hasOwn(registry.projects, name)) throw new Error('Project already exists; nothing overwritten.');
    const channels = option(args, '--channels', '').split(',').map((name) => name.trim());
    const value = validateProject({ name, repository: option(args, '--repo'), relay: option(args, '--relay'),
      workspace: option(args, '--workspace', process.env.INIT_CWD || process.cwd()), channels, report_channel: option(args, '--report-channel', channels[0]),
      owner_public_key: option(args, '--owner'), relay_signer: option(args, '--signer'), watch_config: option(args, '--watch-config') });
    if (!statSync(value.workspace).isDirectory()) throw new Error('workspace must be a directory.');
    registry.projects[name] = value; saveRegistry(registry); console.log(`Added ${name}. Run project connect --project ${name}; membership approval is still required.`); return;
  }
  if (command === 'use') {
    selectProject({ ...process.env, BUZZ_PROJECT_SNAPSHOT: '', BUZZ_PROJECT: name }, ['node']);
    registry.selected = name; saveRegistry(registry); console.log(`Selected ${name}. Existing runners retain their project.`); return;
  }
  if (command === 'connect') {
    if (project.name === 'legacy') throw new Error('Legacy remains unchanged. Select a named project with --project NAME.');
    const env = { ...process.env, BUZZ_PROJECT_SNAPSHOT: JSON.stringify({ ...project, channel_ids: undefined }) };
    const result = spawnSync(process.execPath, [script('../receive-mentions.mjs'), '--connect'], { env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}\nCheck Relay URL, signed 39000/39001/39002 responses and community/channel membership approval. No messages sent.`);
    const record = result.stdout.split(/\r?\n/).find((line) => line.startsWith('PROJECT_CONNECTED='));
    if (!record) throw new Error('Relay did not provide verified project metadata.');
    registry.projects[project.name] = validateProject({ ...project, ...JSON.parse(record.slice('PROJECT_CONNECTED='.length)) });
    saveRegistry(registry); console.log(record); return;
  }
  throw new Error('Use project add NAME --repo OWNER/REPO --relay https://HOST --workspace ABSOLUTE_PATH --channels chat,reports --report-channel reports; list; use NAME; connect/start/status/stop --project NAME.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
