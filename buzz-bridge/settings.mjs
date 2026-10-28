import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultOwner = 'c3aa7c787d6c949dd74b9ef35c2d2fea7149f6c59395c5e94bc03b77ea918cd7';
const defaultAgent = '8b67d6e51fe8c6658be447b0e2884cdcd80bcebbc27d4d0d8390deee5c3a2b7a';
const publicKey = (value) => /^[0-9a-f]{64}$/.test(value ?? '');

export function loadSettings(env = process.env) {
  const configPath = env.BUZZ_BRIDGE_CONFIG
    ? resolve(env.BUZZ_BRIDGE_CONFIG)
    : fileURLToPath(new URL('./config/local.json', import.meta.url));
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || env.BUZZ_BRIDGE_CONFIG) throw new Error('Cannot read Buzz Bridge local configuration.'); }
  const agentName = config.agent_name ?? 'Agent-A';
  if (!/^Agent-[A-Za-z0-9-]{1,32}$/.test(agentName)) throw new Error('agent_name must be Agent-A, Agent-B, etc.');
  const ownerPublicKey = config.owner_public_key ?? defaultOwner;
  const allowedCallers = [...new Set([ownerPublicKey, ...(config.allowed_callers ?? [])])];
  if (!publicKey(ownerPublicKey) || !Array.isArray(config.allowed_callers ?? []) || allowedCallers.length > 100
    || allowedCallers.some((key) => !publicKey(key))) throw new Error('Caller configuration requires 64-character HEX public keys.');
  const stateDirectory = join(env.LOCALAPPDATA ?? '.', 'BuzzBridge');
  const identityPath = join(stateDirectory, `${agentName.toLowerCase()}.identity.json`);
  let storedPublicKey;
  try { storedPublicKey = JSON.parse(readFileSync(identityPath, 'utf8')).public_key; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read configured agent identity.'); }
  const agentPublicKey = config.agent_public_key ?? storedPublicKey ?? (agentName === 'Agent-A' ? defaultAgent : null);
  if (agentPublicKey !== null && !publicKey(agentPublicKey)) throw new Error('Invalid configured agent public key.');
  if (storedPublicKey && agentPublicKey !== storedPublicKey) throw new Error('Configured public key differs from existing identity.');
  return { configPath, agentName, ownerPublicKey, allowedCallers, stateDirectory, identityPath, agentPublicKey };
}

export const settings = loadSettings();
