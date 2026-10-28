import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export const legacy = Object.freeze({ name: 'legacy', repository: 'seongwwww/sumtech',
  origin: 'https://buzz-ciik.srv2103980.hstgr.cloud', relay: 'wss://buzz-ciik.srv2103980.hstgr.cloud/',
  channels: ['test', 'agent-reports'], report_channel: 'agent-reports',
  relay_signer: 'fd65717ed0c6c1a3060778c6fa2811f53d61b64a12d61255260362faac201d98' });
export const registryPath = (env = process.env) => join(env.LOCALAPPDATA ?? '.', 'BuzzBridge', 'projects.json');
export const projectCallers = (owner, local = [], configured = []) => [...new Set([owner, ...local, ...configured].filter(Boolean))];
export function readRegistry(env = process.env) {
  try { const value = JSON.parse(readFileSync(registryPath(env), 'utf8'));
    if (value.version !== 1 || !value.projects || typeof value.projects !== 'object') throw new Error('Invalid project registry; retain it for inspection.');
    return value;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, selected: 'legacy', projects: {} }; }
}
export function saveRegistry(value, env = process.env) {
  const file = registryPath(env), temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(join(env.LOCALAPPDATA ?? '.', 'BuzzBridge'), { recursive: true });
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temp, file);
}
export function validateProject(value) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value.name ?? '') || value.name === 'legacy') throw new Error('Project name: lowercase letters/digits/hyphens; legacy is reserved.');
  const repository = String(value.repository ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use GitHub owner/repository or its HTTPS URL.');
  const url = new URL(value.relay ?? value.origin);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Relay must be an HTTPS/WSS origin without path or credentials.');
  url.protocol = 'https:'; const origin = url.origin;
  if (!Array.isArray(value.channels) || !value.channels.length || value.channels.length > 30
    || value.channels.some((c) => typeof c !== 'string' || !c.trim() || c.length > 100 || /[,\x00-\x1f]/.test(c))
    || new Set(value.channels).size !== value.channels.length || !value.channels.includes(value.report_channel)) throw new Error('Provide unique channel names including report_channel.');
  if (!isAbsolute(value.workspace ?? '')) throw new Error('workspace must be an absolute existing repository/document root.');
  for (const key of ['owner_public_key', 'relay_signer']) if (value[key] != null && !/^[a-f0-9]{64}$/.test(value[key])) throw new Error(`${key} requires a HEX public key.`);
  if (value.allowed_callers != null && (!Array.isArray(value.allowed_callers) || value.allowed_callers.some((key) => !/^[a-f0-9]{64}$/.test(key)))) throw new Error('Invalid project allowed_callers.');
  return { ...value, repository, origin, relay: origin.replace('https:', 'wss:') + '/', workspace: resolve(value.workspace),
    ...(value.watch_config ? { watch_config: resolve(value.watch_config) } : {}) };
}
export function selectProject(env = process.env, args = process.argv) {
  // A managed process inherits an immutable snapshot. Later `use` never redirects it.
  if (env.BUZZ_PROJECT_SNAPSHOT) return Object.freeze(validateProject(JSON.parse(env.BUZZ_PROJECT_SNAPSHOT)));
  const index = args.indexOf('--project');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('-'))) throw new Error('--project requires a name.');
  if ((index >= 0 ? args[index + 1] : env.BUZZ_PROJECT) === 'legacy') return legacy;
  const registry = readRegistry(env);
  const name = index >= 0 ? args[index + 1] : env.BUZZ_PROJECT || registry.selected;
  if (name === 'legacy') return legacy;
  if (!Object.hasOwn(registry.projects, name)) throw new Error(`Unknown project ${name}. Use project add/list or --project legacy.`);
  const project = validateProject(registry.projects[name]);
  if (project.name !== name) throw new Error('Project registry name mismatch.');
  return Object.freeze(project);
}
export const project = selectProject();
export const stateDirectory = (env = process.env) => project.name === 'legacy'
  ? join(env.LOCALAPPDATA ?? '.', 'BuzzBridge')
  : join(env.LOCALAPPDATA ?? '.', 'BuzzBridge', 'projects', project.name);
