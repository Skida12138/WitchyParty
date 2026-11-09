import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createDeepSeekStub } from './deepseek-stub.js';

// A public test fixture credential, unrelated to any local or deployed invite.
export const TEST_INVITE_HASH = createHash('sha256').update('witchy-party-invite-test-fixture').digest('hex');

export async function until(predicate, timeout = 7000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`); await delay(10); }
}

export async function fixture(t, { env = {}, responses, prices, pauseIntervals = false, apiKey = 'test-only', inviteHash = TEST_INVITE_HASH } = {}) {
  if (typeof env.INVITE_CODE_SHA256 === 'string' && /^[a-f0-9]{64}$/i.test(env.INVITE_CODE_SHA256)) inviteHash = env.INVITE_CODE_SHA256.toLowerCase();
  const api = await createDeepSeekStub({ responses, prices }), clients = new Set();
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const chainFixture = env.NODE_OPTIONS?.includes('chain-reaction-random.js');
  const rustFixture = process.env.WITCHY_SERVER_BIN && (chainFixture || pauseIntervals);
  const rustServer = rustFixture ? process.env.WITCHY_FIXTURE_BIN : process.env.WITCHY_SERVER_BIN;
  if (rustFixture && !rustServer) throw new Error('This deterministic Rust test requires WITCHY_FIXTURE_BIN (run npm run test:rust)');
  const child = spawn(rustServer || process.execPath, rustServer ? [] : [...(pauseIntervals ? ['--import', './tests/helpers/paused-intervals.js'] : []), 'server/index.js'], {
    cwd: new URL('../..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: api.url,
      ...(rustFixture ? { WITCHY_TEST_CHAIN: chainFixture ? '1' : '0', WITCHY_TEST_PAUSE_MAINTENANCE: pauseIntervals ? '1' : '0' } : {}),
      ROOM_LOG_ENABLED: '0', INVITE_CODE_SHA256: inviteHash, DEPOSIT_MS: '20', REACTION_MS: '25', HOLD_MS: '20',
      RECONNECT_GRACE_MS: '700', HEARTBEAT_INTERVAL_MS: '1000', HEARTBEAT_TIMEOUT_MS: '1000', ...env },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(1000)]); }
    await api.close();
  });
  const url = `http://127.0.0.1:${port}`;
  const inviteHeaders = { 'X-Invite-Hash': inviteHash }, protocols = ['witchy-v1', `invite.${inviteHash}`];
  let health, healthStatus;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${url}/api/health`, { headers: inviteHeaders });
      const value = await response.json();
      if (response.ok || response.status === 503 && value.code === 'INVITE_NOT_CONFIGURED') { health = value; healthStatus = response.status; break; }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Test server stopped: ${output}`);
    await delay(40);
  }
  assert.ok(health, output);
  async function connect(options = {}) {
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/ws`, protocols, options), messages = [];
    let sequence = 0;
    const closed = new Promise(resolve => ws.once('close', resolve));
    const client = {
      ws, messages, state: null, session: null, closed,
      async send(type, payload = {}, expectError = false) {
        const requestId = `test-${++sequence}`;
        ws.send(JSON.stringify({ type, requestId, payload, inviteHash }));
        await until(() => messages.some(message => message.requestId === requestId && ['ack', 'error'].includes(message.type)), 7000, `${type} reply ${output}`);
        const reply = messages.find(message => message.requestId === requestId && ['ack', 'error'].includes(message.type));
        assert.equal(reply.type, expectError ? 'error' : 'ack', reply.message);
        return reply;
      },
      action(action, payload = {}, expectError = false) { return client.send('action', { action, ...payload }, expectError); },
      async stateWhere(predicate, { after = 0, timeout = 7000 } = {}) {
        const find = () => messages.slice(after).find(message => message.type === 'state' && predicate(message.state));
        await until(find, timeout, `state; last=${JSON.stringify(client.state)}`);
        return find().state;
      },
      async disconnect() { ws.close(); await closed; },
      close() { ws.terminate(); },
      saved() { const { roomId, playerId, token } = client.session; return { roomId, playerId, token }; },
    };
    ws.on('message', raw => { const message = JSON.parse(raw); messages.push(message); if (message.type === 'state') client.state = message.state; if (message.type === 'session') client.session = message; });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    clients.add(client);
    return client;
  }
  return { api, connect, health, healthStatus, url, child, inviteHash, inviteHeaders, protocols };
}

export async function humans(server, count = 2, rounds = 3) {
  const host = await server.connect();
  await host.send('create', { name: '月光玩家', rounds });
  const players = [host];
  for (let i = 1; i < count; i++) { const guest = await server.connect(); await guest.send('join', { name: `朋友${i}`, roomId: host.session.roomId }); players.push(guest); }
  return players;
}

export async function prepare(client, name = '晨露') {
  await client.action('quote', { name });
  const quote = client.state.me.quotes.at(-1);
  await client.action('commit', { quoteId: quote.id });
  return quote;
}
