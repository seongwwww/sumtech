import { windowsPowerShellEnv } from './windows-env.mjs';
import { settings } from './settings.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

// Run manually with Node. Never print or persist the unencrypted secret key.
async function main() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('This initializer requires a Windows user account.');
  }
  const directory = settings.stateDirectory;
  const identityPath = settings.identityPath;
  let existing;
  try {
    existing = JSON.parse(await readFile(identityPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Existing identity could not be read. Nothing was overwritten.');
  }
  if (existing) {
    if (!/^[0-9a-f]{64}$/.test(existing.public_key ?? '') || !existing.encrypted_private_key) {
      throw new Error('Existing identity is incomplete. Nothing was overwritten.');
    }
    console.log(`Existing ${settings.agentName} identity retained.`);
    console.log(`PUBLIC_KEY=${existing.public_key}`);
    console.log(`IDENTITY_FILE=${identityPath}`);
    return;
  }

  const secret = generateSecretKey();
  try {
    const publicKey = getPublicKey(secret);
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encryptCommand = [
      "$ErrorActionPreference = 'Stop'",
      '$raw = [Console]::In.ReadToEnd()',
      '$secure = ConvertTo-SecureString -String $raw -AsPlainText -Force',
      'ConvertFrom-SecureString -SecureString $secure',
    ].join('; ');
    let encrypted;
    try {
      encrypted = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', encryptCommand], {
        input: Buffer.from(secret).toString('hex'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        env: windowsPowerShellEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new Error('Windows DPAPI encryption failed. No identity was saved.');
    }
    if (!/^[0-9a-f]+$/i.test(encrypted) || !encrypted.startsWith('01000000')) {
      throw new Error('Unexpected encryption result. No identity was saved.');
    }
    await mkdir(directory, { recursive: true });
    await writeFile(identityPath, JSON.stringify({
      version: 1,
      agent: settings.agentName,
      relay_url: 'wss://buzz-ciik.srv2103980.hstgr.cloud/',
      public_key: publicKey,
      protection: 'Windows DPAPI CurrentUser',
      encrypted_private_key: encrypted,
      created_at: new Date().toISOString(),
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(`${settings.agentName} identity created; private key encrypted with Windows DPAPI.`);
    console.log(`PUBLIC_KEY=${publicKey}`);
    console.log(`IDENTITY_FILE=${identityPath}`);
  } finally {
    secret.fill(0);
  }
}

main().catch(() => {
  console.error('Identity initialization did not complete. No existing identity was overwritten.');
  process.exitCode = 1;
});
