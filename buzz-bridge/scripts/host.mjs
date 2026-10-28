import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [instance, mode, backend, directory, watchFile = ''] = process.argv.slice(2);
if (!/^[a-f0-9]{32}$/.test(instance ?? '') || !['listen', 'notifications'].includes(mode)
  || !['codex', 'claude'].includes(backend)) throw new Error('Invalid managed launch.');
const statePath = join(directory, 'runner.json'), stopPath = join(directory, `stop-${instance}`);
await mkdir(directory, { recursive: true });
const bridge = fileURLToPath(new URL('../receive-mentions.mjs', import.meta.url));
const args = [bridge, '--agent', backend, '--channels', 'test,agent-reports',
  mode === 'listen' ? '--listen' : '--watch-github'];
if (watchFile) args.push('--watch-config', watchFile);
const child = spawn(process.execPath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
let terminating = false;
const terminate = () => {
  if (terminating) return;
  terminating = true;
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
  catch { child.kill(); }
};
const timer = setInterval(async () => {
  try { await readFile(stopPath); terminate(); } catch (error) { if (error.code !== 'ENOENT') terminate(); }
}, 250);
process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
child.once('error', () => { console.error('Managed bridge could not start.'); process.exitCode = 1; });
child.once('close', async (code) => {
  clearInterval(timer);
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.instance === instance) await unlink(statePath);
  } catch (error) { if (error.code !== 'ENOENT') console.error('Runner record needs inspection.'); }
  await unlink(stopPath).catch(() => {});
  process.exitCode = terminating ? 0 : (code ?? 1);
});
