import { join } from 'node:path';

// Windows environment names are case-insensitive. Remove every inherited spelling
// before restoring Windows PowerShell's own autoload path in the child only.
export function windowsPowerShellEnv(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const root = Object.entries(source).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (!root) throw new Error('SystemRoot is required for Windows PowerShell.');
  env.PSModulePath = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}
