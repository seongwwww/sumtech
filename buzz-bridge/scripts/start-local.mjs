import { project } from '../projects.mjs';
import { lifecycle } from './project.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { windowsPowerShellEnv } from '../windows-env.mjs';

if (project.name !== 'legacy') { lifecycle('start', process.argv.slice(2)); } else {
const args = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
if (projectIndex >= 0) args.splice(projectIndex, 2);
const aliases = { '--agent': '-Agent', '--mode': '-Mode', '--watch-config': '-WatchConfig' };
for (let i = 0; i < args.length; i++) args[i] = aliases[args[i]] ?? args[i];
process.env.BUZZ_PROJECT = 'legacy';
const localWatch = fileURLToPath(new URL('../config/watch.local.json', import.meta.url));
if (existsSync(localWatch) && !args.some((arg) => arg.toLowerCase() === '-watchconfig')) args.push('-WatchConfig', localWatch);
const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./run.ps1', import.meta.url)), ...args],
  { stdio: 'inherit', windowsHide: true, env: windowsPowerShellEnv() });
process.exitCode = result.status ?? 1;

}
