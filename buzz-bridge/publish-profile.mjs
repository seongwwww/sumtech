import { windowsPowerShellEnv } from './windows-env.mjs';
import { settings } from './settings.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';
import WebSocket from 'ws';

const RELAY = 'wss://buzz-ciik.srv2103980.hstgr.cloud/';
const PUBLIC_KEY = settings.agentPublicKey;

async function main() {
  const identity = JSON.parse(await readFile(settings.identityPath, 'utf8'));
  if (identity.public_key !== PUBLIC_KEY || identity.relay_url !== RELAY || identity.protection !== 'Windows DPAPI CurrentUser') {
    throw new Error('Identity does not match the approved agent and relay.');
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$secure = ConvertTo-SecureString -String ([Console]::In.ReadToEnd())',
    '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
  ].join('; ');
  let secretHex;
  try {
    secretHex = execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command], {
        input: identity.encrypted_private_key, encoding: 'utf8', windowsHide: true,
        timeout: 15000, env: windowsPowerShellEnv(), stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
  } catch { throw new Error('Cannot decrypt the agent key under this Windows account.'); }
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) throw new Error('Invalid decrypted key.');
  const secret = Uint8Array.from(Buffer.from(secretHex, 'hex'));
  secretHex = undefined;
  try {
    if (getPublicKey(secret) !== PUBLIC_KEY) throw new Error('Public key check failed.');
    await (process.argv.includes('--http') ? publishHttp(secret) : publish(secret));
  } finally { secret.fill(0); }
}

// The official Buzz CLI uses the NIP-98 HTTP bridge for stored events.
async function publishHttp(secret) {
  console.log('PROFILE_TRANSPORT=HTTPS_NIP98_V1');
  const origin = 'https://buzz-ciik.srv2103980.hstgr.cloud';
  const clean = (value) => String(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 700);
  async function post(path, value) {
    const url = origin + path;
    const body = JSON.stringify(value);
    const auth = finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', url], ['method', 'POST'], ['nonce', randomUUID()],
        ['payload', createHash('sha256').update(body, 'utf8').digest('hex')]],
    }, secret);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json',
          Authorization: `Nostr ${Buffer.from(JSON.stringify(auth), 'utf8').toString('base64')}` },
        body,
      });
    } catch { throw new Error(`Relay HTTPS ${path} failed or timed out. Do not blindly retry a publication.`); }
    const text = await response.text();
    if (!response.ok) throw new Error(`Relay HTTPS ${path} HTTP ${response.status}: ${clean(text) || '(empty response body)'}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Relay HTTPS ${path} HTTP ${response.status}: unexpected response format.`); }
  }
  function eventsFrom(result) {
    const events = Array.isArray(result) ? result : result?.events;
    if (!Array.isArray(events)) throw new Error('Relay HTTPS query returned an unexpected event list.');
    return events.filter((event) => event.kind === 0 && event.pubkey === PUBLIC_KEY && verifyEvent(event))
      .sort((a, b) => b.created_at - a.created_at);
  }
  const filter = [{ kinds: [0], authors: [PUBLIC_KEY], limit: 1 }];
  const latest = eventsFrom(await post('/query', filter))[0];
  console.log('Agent-A HTTPS profile query accepted.');
  let previous = {};
  if (latest) {
    try {
      const parsed = JSON.parse(latest.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
    } catch { throw new Error('Profile metadata is malformed; refusing to overwrite it.'); }
  }
  const content = JSON.stringify({ ...previous, name: settings.agentName, display_name: settings.agentName,
    about: 'Local Codex bridge identity. Runtime is operated separately from Buzz Desktop.' });
  if (latest?.content === content) {
    console.log(`VERIFIED_PROFILE=${settings.agentName} PUBLIC_KEY=${PUBLIC_KEY} (already published)`);
    return;
  }
  const profile = finalizeEvent({ kind: 0, created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
    tags: latest?.tags ?? [], content }, secret);
  const receipt = await post('/events', profile);
  const accepted = receipt?.accepted === true || (Array.isArray(receipt) && receipt[0] === 'OK' && receipt[1] === profile.id && receipt[2] === true);
  if (!accepted) throw new Error(`Relay HTTPS profile was not confirmed accepted: ${clean(JSON.stringify(receipt))}`);
  console.log('Agent-A profile publication accepted.');
  const confirmed = eventsFrom(await post('/query', filter)).some((event) => event.id === profile.id);
  if (!confirmed) throw new Error('Profile publication was accepted but readback did not confirm it.');
  console.log(`VERIFIED_PROFILE=${settings.agentName} PUBLIC_KEY=${PUBLIC_KEY}`);
}

function publish(secret) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(RELAY, { maxPayload: 1024 * 1024, handshakeTimeout: 15000 });
    const timer = setTimeout(() => finish(new Error('Relay operation timed out; inspect profile before retrying.')), 30000);
    let settled = false;
    let authId;
    let phase = 'authentication';
    let latest;
    let profile;
    let readBack = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      error ? reject(error) : resolve();
    }
    socket.on('error', () => finish(new Error('Relay network or TLS connection failed.')));
    socket.on('close', () => { if (!settled) finish(new Error('Relay closed before profile verification completed.')); });
    socket.on('message', (bytes) => {
      if (settled) return;
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
          if (authId) throw new Error('Unexpected repeat authentication challenge.');
          const auth = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
            tags: [['relay', RELAY], ['challenge', frame[1]]], content: '' }, secret);
          authId = auth.id;
          socket.send(JSON.stringify(['AUTH', auth]));
        } else if (frame[0] === 'OK' && frame[1] === authId) {
          if (frame[2] !== true) throw new Error('Relay rejected Agent-A authentication. Check community membership.');
          console.log('Agent-A relay authentication accepted.');
          phase = 'read';
          socket.send(JSON.stringify(['REQ', 'existing-profile', { kinds: [0], authors: [PUBLIC_KEY], limit: 1 }]));
        } else if (frame[0] === 'EVENT' && frame[1] === 'existing-profile' && phase === 'read') {
          const event = frame[2];
          if (event.kind === 0 && event.pubkey === PUBLIC_KEY && verifyEvent(event) && (!latest || event.created_at > latest.created_at)) latest = event;
        } else if (frame[0] === 'EOSE' && frame[1] === 'existing-profile' && phase === 'read') {
          socket.send(JSON.stringify(['CLOSE', 'existing-profile']));
          let previous = {};
          if (latest) { try { const parsed = JSON.parse(latest.content); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed; } catch {} }
          const metadata = { ...previous, name: settings.agentName, display_name: settings.agentName,
            about: 'Local Codex bridge identity. Runtime is operated separately from Buzz Desktop.' };
          profile = finalizeEvent({ kind: 0, created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
            tags: latest?.tags ?? [], content: JSON.stringify(metadata) }, secret);
          phase = 'publish';
          socket.send(JSON.stringify(['EVENT', profile]));
        } else if (frame[0] === 'OK' && frame[1] === profile?.id && phase === 'publish') {
          if (frame[2] !== true) throw new Error('Relay rejected the profile publication.');
          console.log('Agent-A profile publication accepted.');
          phase = 'verify';
          socket.send(JSON.stringify(['REQ', 'verify-profile', { kinds: [0], authors: [PUBLIC_KEY], limit: 1 }]));
        } else if (frame[0] === 'EVENT' && frame[1] === 'verify-profile' && phase === 'verify') {
          const event = frame[2];
          if (event.id === profile.id && event.pubkey === PUBLIC_KEY && verifyEvent(event)) readBack = true;
        } else if (frame[0] === 'EOSE' && frame[1] === 'verify-profile' && phase === 'verify') {
          if (!readBack) throw new Error('Profile was accepted but could not be confirmed by readback.');
          console.log(`VERIFIED_PROFILE=${settings.agentName} PUBLIC_KEY=${PUBLIC_KEY}`);
          socket.send(JSON.stringify(['CLOSE', 'verify-profile']));
          finish();
        } else if (frame[0] === 'CLOSED') {
          // This response concerns only our public profile filter; no secret or auth frame is logged.
          const reason = typeof frame[2] === 'string'
            ? frame[2].replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 500)
            : 'No reason supplied';
          throw new Error(`Relay refused the profile query (${String(frame[1]).slice(0, 64)}): ${reason}`);
        }
      } catch (error) { finish(error instanceof Error ? error : new Error('Unexpected relay response.')); }
    });
  });
}

main().catch((error) => {
  // Only fixed diagnostics above are shown; never log subprocess output or identity contents.
  console.error(error instanceof Error && /^(Identity|Cannot|Invalid|Public key|Relay|Unexpected|Profile)/.test(error.message)
    ? error.message : 'Profile operation failed. Private key was not logged.');
  process.exitCode = 1;
});
