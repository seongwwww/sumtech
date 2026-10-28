const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cwd = path.resolve(__dirname, '..');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buzz-project-regression-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { getPublicKey } = await import('nostr-tools');
  const agent = getPublicKey(new Uint8Array(32).fill(1));
  const caller = getPublicKey(new Uint8Array(32).fill(2));
  const env = { ...process.env, LOCALAPPDATA: dir, BUZZ_PROJECT: '', BUZZ_PROJECT_SNAPSHOT: '',
    BUZZ_BRIDGE_CONFIG: path.join(dir, 'local.json') };
  await fs.writeFile(env.BUZZ_BRIDGE_CONFIG, JSON.stringify({ agent_name: 'Agent-B', agent_public_key: agent, allowed_callers: [caller] }));
  const cli = (...args) => execFileSync(process.execPath, ['scripts/project.mjs', ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  for (const name of ['alpha', 'beta']) {
    const workspace = path.join(dir, `${name} checkout with spaces`);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'README.md'), `${name} project document`);
    cli('add', name, '--repo', `team/${name}`, '--relay', `wss://${name}.example/`, '--workspace', workspace, '--channels', `${name}-reports`);
  }
  const run = (name, code, args = []) => execFileSync(process.execPath, ['--input-type=module', '-e', code, ...args],
    { cwd, env: { ...env, BUZZ_PROJECT: name }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { dir, env, cli, run, agent, caller, cwd };
}
module.exports = { fixture };
