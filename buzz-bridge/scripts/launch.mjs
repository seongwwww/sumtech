import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
const [host, instance, mode, backend, directory, watchFile, stdout, stderr, pidFile, config, dataDirectory] = process.argv.slice(2);
const out = openSync(stdout, 'w'), err = openSync(stderr, 'w');
try {
  const child = spawn(process.execPath, [host, instance, mode, backend, directory, watchFile], {
    windowsHide: true, detached: true, shell: false, stdio: ['ignore', out, err],
    env: { ...process.env, ...(config ? { BUZZ_BRIDGE_CONFIG: config } : {}),
      ...(dataDirectory ? { LOCALAPPDATA: dataDirectory } : {}) },
  });
  child.once('error', () => { console.error('Detached host launch failed.'); process.exitCode = 1; });
  child.once('spawn', () => { writeFileSync(pidFile, String(child.pid)); child.unref(); });
} finally { closeSync(out); closeSync(err); }
