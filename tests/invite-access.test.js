import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { allowedSocketOrigin, createInviteAccess, inviteHashFromProtocols } from '../server/invite-access.js';
import { fixture, humans, TEST_INVITE_HASH, until } from './helpers/live-server.js';

const wrongHash = '0'.repeat(64);
const wsUrl = server => `${server.url.replace('http:', 'ws:')}/ws`;

function rejectedUpgrade(server, protocols, { suffix = '', ...options } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl(server)}${suffix}`, protocols, options);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('The rejected upgrade did not finish')); }, 5000);
    socket.on('error', () => {});
    socket.once('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('An unauthorized connection completed its handshake')); });
    socket.once('unexpected-response', (request, response) => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => {
        clearTimeout(timeout); request.destroy(); socket.terminate();
        resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) });
      });
      response.once('error', error => { clearTimeout(timeout); socket.terminate(); reject(error); });
    });
  });
}

async function assertMessageRejected(client, message, { raw = false } = {}) {
  const marker = client.messages.length;
  client.ws.send(raw ? message : JSON.stringify(message));
  assert.equal(await client.closed, 4004);
  const replies = client.messages.slice(marker);
  assert.ok(replies.some(reply => reply.type === 'error' && reply.code === 'INVITE_INVALID'));
  assert.ok(!replies.some(reply => ['ack', 'session', 'state'].includes(reply.type)));
  assert.ok(!JSON.stringify(replies).includes(TEST_INVITE_HASH));
  return replies;
}

test('invite hashes require a configured SHA-256 value and compare fixed-length hexadecimal bytes', () => {
  const access = createInviteAccess(TEST_INVITE_HASH);
  assert.equal(access.configured, true);
  assert.doesNotThrow(() => access.assertHash(TEST_INVITE_HASH));
  assert.doesNotThrow(() => access.assertHash(TEST_INVITE_HASH.toUpperCase()));
  assert.doesNotThrow(() => createInviteAccess(TEST_INVITE_HASH.toUpperCase()).assertHash(TEST_INVITE_HASH));
  for (const value of [undefined, null, '', 123, [], {}, wrongHash, 'g'.repeat(64), TEST_INVITE_HASH.slice(1), `${TEST_INVITE_HASH}0`, ` ${TEST_INVITE_HASH}`]) {
    assert.throws(() => access.assertHash(value), error => error.code === 'INVITE_INVALID' && error.status === 401 && !error.message.includes(TEST_INVITE_HASH));
  }
  for (const value of [undefined, null, '', 'x', 'g'.repeat(64), 'a'.repeat(63), `${TEST_INVITE_HASH} `]) {
    const unavailable = createInviteAccess(value);
    assert.equal(unavailable.configured, false);
    assert.throws(() => unavailable.assertHash(TEST_INVITE_HASH), error => error.code === 'INVITE_NOT_CONFIGURED' && error.status === 503);
  }
});

test('WebSocket credentials require the application protocol and origins support bracketed IPv6 hosts', () => {
  assert.equal(inviteHashFromProtocols(`witchy-v1, invite.${TEST_INVITE_HASH}`), TEST_INVITE_HASH);
  assert.equal(inviteHashFromProtocols(`invite.${TEST_INVITE_HASH}, witchy-v1`), TEST_INVITE_HASH);
  for (const value of [undefined, [], '', 'witchy-v1', `invite.${TEST_INVITE_HASH}`, `other, invite.${TEST_INVITE_HASH}`, `witchy-v1, invite.${TEST_INVITE_HASH}, extra`, 'witchy-v1, invite.invalid']) assert.equal(inviteHashFromProtocols(value), null);
  assert.equal(allowedSocketOrigin(undefined, '127.0.0.1:3001'), true);
  assert.equal(allowedSocketOrigin('http://[::1]:5173', '[::1]:3001'), true);
  assert.equal(allowedSocketOrigin('http://localhost:5173', '[::1]:3001'), true);
  assert.equal(allowedSocketOrigin('https://party.example', 'party.example:443'), true);
  assert.equal(allowedSocketOrigin('https://other.example', 'party.example:443'), false);
  assert.equal(allowedSocketOrigin('http://[::1]:5173', 'party.example'), false);
  assert.equal(allowedSocketOrigin('not-an-origin', '127.0.0.1:3001'), false);
  assert.equal(allowedSocketOrigin('https://user:password@party.example', 'party.example'), false);
});

test('all API routes authenticate before routing and never cache invite checks or health responses', async t => {
  const server = await fixture(t);
  for (const route of ['/api/access', '/api/health', '/api/unknown', '/api/rooms/private']) {
    for (const headers of [{}, { 'X-Invite-Hash': wrongHash }, { 'X-Invite-Hash': 'invalid' }]) {
      const response = await fetch(`${server.url}${route}`, { headers });
      assert.equal(response.status, 401, route); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert.equal(body.code, 'INVITE_INVALID'); assert.equal(body.ok, false);
      assert.ok(!JSON.stringify(body).includes(TEST_INVITE_HASH));
    }
  }
  for (const route of ['/api/access', '/api/health']) {
    const response = await fetch(`${server.url}${route}`, { headers: { 'X-Invite-Hash': server.inviteHash.toUpperCase() } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.ok, true);
    if (route === '/api/access') assert.deepEqual(body, { ok: true });
  }
  const unknown = await fetch(`${server.url}/api/unknown`, { headers: server.inviteHeaders });
  assert.equal(unknown.status, 404); assert.equal(unknown.headers.get('cache-control'), 'no-store');
  const urlCredential = await fetch(`${server.url}/api/access?inviteHash=${server.inviteHash}`);
  assert.equal(urlCredential.status, 401, 'Credentials are accepted from the header, not from query parameters');
  const entry = await fetch(server.url);
  assert.ok(![401, 503].includes(entry.status), 'The public application shell must remain loadable');
  assert.equal(server.api.requests.length, 0);
});

for (const configuredHash of ['', 'not-a-sha256-value']) {
  test(`an ${configuredHash ? 'invalid' : 'absent'} invite configuration fails closed for HTTP and WebSocket access`, async t => {
    const server = await fixture(t, { env: { INVITE_CODE_SHA256: configuredHash } });
    assert.equal(server.healthStatus, 503); assert.equal(server.health.code, 'INVITE_NOT_CONFIGURED');
    for (const route of ['/api/access', '/api/health', '/api/unknown']) {
      const response = await fetch(`${server.url}${route}`, { headers: server.inviteHeaders });
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).code, 'INVITE_NOT_CONFIGURED');
    }
    const upgrade = await rejectedUpgrade(server, server.protocols);
    assert.equal(upgrade.status, 503); assert.equal(upgrade.body.code, 'INVITE_NOT_CONFIGURED');
    assert.equal(upgrade.headers['cache-control'], 'no-store');
    assert.ok(![401, 503].includes((await fetch(server.url)).status));
    assert.equal(server.api.requests.length, 0);
  });
}

test('unauthenticated WebSockets never upgrade and the credential protocol is never negotiated back', async t => {
  const server = await fixture(t);
  for (const protocols of [undefined, ['witchy-v1'], [`invite.${server.inviteHash}`], ['witchy-v1', `invite.${wrongHash}`], ['other', `invite.${server.inviteHash}`], [...server.protocols, 'extra']]) {
    const rejected = await rejectedUpgrade(server, protocols);
    assert.equal(rejected.status, 401); assert.equal(rejected.body.code, 'INVITE_INVALID');
    assert.equal(rejected.headers['cache-control'], 'no-store'); assert.equal(rejected.headers['sec-websocket-protocol'], undefined);
    assert.ok(!JSON.stringify(rejected.body).includes(server.inviteHash));
  }
  assert.equal((await rejectedUpgrade(server, undefined, { suffix: `?inviteHash=${server.inviteHash}` })).status, 401);
  const client = await server.connect(); assert.equal(client.ws.protocol, 'witchy-v1');
  await client.disconnect(); assert.equal(server.api.requests.length, 0);
});

test('origin validation still rejects unrelated sites before an authenticated WebSocket upgrade', async t => {
  const server = await fixture(t);
  const rejected = await rejectedUpgrade(server, server.protocols, { origin: 'https://unrelated.example' });
  assert.equal(rejected.status, 403); assert.equal(rejected.body.code, 'ORIGIN_INVALID');
  const local = await server.connect({ origin: 'http://[::1]:5173', headers: { Host: '[::1]:3001' } });
  assert.equal(local.ws.protocol, 'witchy-v1'); await local.disconnect();
});

test('every JSON message checks the invite before its action, payload, room or resume credentials', async t => {
  const server = await fixture(t);
  for (const type of ['create', 'join', 'resume', 'leave', 'chat', 'action', 'unsupported']) {
    for (const inviteHash of [undefined, wrongHash]) {
      const client = await server.connect();
      await assertMessageRejected(client, { type, requestId: `${type}-rejected`, payload: 'invalid business parameters', inviteHash });
    }
  }
  for (const raw of ['{broken', 'null', '[]', '"text"']) {
    const client = await server.connect(); await assertMessageRejected(client, raw, { raw: true });
  }
  const queued = await server.connect();
  queued.ws.send(JSON.stringify({ type: 'create', requestId: 'bad-first', payload: { name: '不应创建', rounds: 3 }, inviteHash: wrongHash }));
  queued.ws.send(JSON.stringify({ type: 'create', requestId: 'valid-after-revocation', payload: { name: '也不应创建', rounds: 3 }, inviteHash: server.inviteHash }));
  assert.equal(await queued.closed, 4004);
  assert.ok(queued.messages.every(message => message.type === 'error' && message.code === 'INVITE_INVALID'));
  assert.equal(server.api.requests.length, 0);
});

test('an invalid quote or leave cannot act on a bound seat, and valid create, join, resume and leave still work', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '3000' } }), [host, guest] = await humans(server);
  assert.equal(host.ws.protocol, 'witchy-v1'); assert.equal(guest.ws.protocol, 'witchy-v1');
  await host.action('start'); const saved = guest.saved();
  await assertMessageRejected(guest, { type: 'action', requestId: 'invalid-quote', payload: { action: 'quote', name: '未经邀请不得召唤的材料' }, inviteHash: wrongHash });
  await host.stateWhere(state => state.players.find(player => player.id === saved.playerId)?.connected === false);
  assert.equal(server.api.requests.length, 0);
  const restored = await server.connect(); await restored.send('resume', saved);
  assert.deepEqual(restored.saved(), saved); assert.equal(restored.state.me.quotes.length, 0); assert.equal(restored.state.me.coins, 20000);
  await assertMessageRejected(restored, { type: 'leave', requestId: 'invalid-leave', payload: {} });
  await until(() => host.state.players.find(player => player.id === saved.playerId)?.connected === false);
  assert.equal(host.state.players.find(player => player.id === saved.playerId).departurePending, false, 'Rejected leave only closes the connection; it cannot confirm a room departure');
  const leaving = await server.connect(); await leaving.send('resume', saved);
  await leaving.send('leave');
  const ended = await host.stateWhere(state => state.phase === 'finished');
  assert.ok(!ended.players.some(player => player.id === saved.playerId));
  assert.equal(ended.roundResult.players.find(player => player.id === saved.playerId).cost, 0);
  assert.equal(server.api.requests.length, 0);
});
