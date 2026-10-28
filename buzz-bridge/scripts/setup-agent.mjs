import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1];
const caller = args.includes('--caller') ? args[args.indexOf('--caller') + 1] : null;
if (!args.includes('--name') || !/^Agent-[A-Za-z0-9-]{1,32}$/.test(name ?? '')
  || (caller !== null && !/^[0-9a-f]{64}$/.test(caller))) {
  throw new Error('Usage: node scripts/setup-agent.mjs --name Agent-B --caller <your Buzz HEX public key>');
}
const configPath = process.env.BUZZ_BRIDGE_CONFIG ? resolve(process.env.BUZZ_BRIDGE_CONFIG)
  : fileURLToPath(new URL('../config/local.json', import.meta.url));
const example = JSON.parse(await readFile(new URL('../config/agent.example.json', import.meta.url), 'utf8'));
await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, JSON.stringify({ agent_name: name, owner_public_key: example.owner_public_key,
  allowed_callers: caller ? [caller] : [] }, null, 2) + '\n', { flag: 'wx' });
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../initialize-agent.mjs', import.meta.url))],
  { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('Local config retained; identity initialization failed. Inspect before retrying.');
console.log('NEXT: community admin adds PUBLIC_KEY to Membership; publish profile; add the agent to the working channel.');
