import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { windowsPowerShellEnv } from '../windows-env.mjs';

const args = process.argv.slice(2);
const localWatch = fileURLToPath(new URL('../config/watch.local.json', import.meta.url));
if (existsSync(localWatch) && !args.some((arg) => arg.toLowerCase() === '-watchconfig')) args.push('-WatchConfig', localWatch);
const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./run.ps1', import.meta.url)), ...args],
  { stdio: 'inherit', windowsHide: true, env: windowsPowerShellEnv() });
process.exitCode = result.status ?? 1;
