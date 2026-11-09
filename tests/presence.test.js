import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { fixture, humans, prepare, until } from './helpers/live-server.js';

const playerIn = (state, id) => state.players.find(player => player.id === id);

test('refreshing a prepared seat retains selected cards, balance, room identity and host', async t => {
  const server = await fixture(t), [host, guest] = await humans(server);
  await host.action('start'); await prepare(host, '不会被刷新遗忘的材料');
  const saved = host.saved(), before = structuredClone(host.state);
  await host.disconnect();
  const offline = await guest.stateWhere(state => playerIn(state, saved.playerId)?.connected === false);
  assert.equal(playerIn(offline, saved.playerId).departurePending, false);
  const resumed = await server.connect(); await resumed.send('resume', saved);
  assert.deepEqual(resumed.saved(), saved);
  assert.deepEqual(resumed.state.me.quotes, before.me.quotes);
  assert.equal(resumed.state.me.preparedQuoteId, before.me.preparedQuoteId);
  assert.equal(resumed.state.me.coins, 20000);
  assert.equal(resumed.state.hostId, saved.playerId);
  await prepare(guest);
  await resumed.stateWhere(state => state.phase === 'roundEnd');
});

test('a returning last human cancels empty-room deletion; AI cannot keep an abandoned room alive', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '450' } }), [host, guest] = await humans(server);
  await host.action('addBot');
  const saved = host.saved();
  await Promise.all([host.disconnect(), guest.disconnect()]);
  await delay(90);
  const resumed = await server.connect(); await resumed.send('resume', saved);
  await delay(520); await resumed.action('addBot');
  assert.equal(resumed.state.players.filter(player => player.bot).length, 2);
  await resumed.disconnect(); await delay(560);
  const stranger = await server.connect();
  assert.equal((await stranger.send('resume', saved, true)).code, 'ROOM_CLOSED');
  await stranger.send('join', { name: '迟来的朋友', roomId: saved.roomId }, true);
  assert.equal(server.api.requests.length, 0);
});

test('join and resume enforce expired empty rooms even when maintenance intervals are paused', async t => {
  const server = await fixture(t, { pauseIntervals: true, env: { RECONNECT_GRACE_MS: '150' } });
  const [first] = await humans(server, 1), [second] = await humans(server, 1);
  const a = first.saved(), b = second.saved();
  await Promise.all([first.disconnect(), second.disconnect()]); await delay(220);
  const newcomer = await server.connect();
  await newcomer.send('join', { name: '过期加入', roomId: a.roomId }, true);
  assert.equal((await newcomer.send('resume', a, true)).code, 'ROOM_CLOSED');
  assert.equal((await newcomer.send('resume', b, true)).code, 'ROOM_CLOSED');
});

test('deleting an empty room aborts an in-flight AI request and late replies cannot create follow-up work', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '250' } }), [host] = await humans(server, 1);
  await host.action('addBot');
  const held = server.api.hold('imagine'), saved = host.saved();
  await host.action('start'); await held.entered;
  await host.disconnect();
  await until(() => server.api.requests[0].closedWithoutResponse, 3000, 'upstream cancellation');
  held.release(); await delay(100);
  assert.equal(server.api.requests.length, 1);
  const replacement = await server.connect();
  assert.equal((await replacement.send('resume', saved, true)).code, 'ROOM_CLOSED');
});

test('empty-room grace starts at the last departure, and a returning survivor receives host authority', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '800' } }), [host, guest] = await humans(server);
  const saved = guest.saved();
  await host.disconnect(); await delay(500); await guest.disconnect(); await delay(500);
  const returning = await server.connect(); await returning.send('resume', saved);
  assert.equal(returning.state.hostId, saved.playerId);
  await delay(350); await returning.action('addBot');
});

test('native heartbeat detects a half-open connection without removing a promptly restored seat', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '650', HEARTBEAT_INTERVAL_MS: '40', HEARTBEAT_TIMEOUT_MS: '80' } });
  const host = await server.connect({ autoPong: false }); await host.send('create', { name: '心跳玩家', rounds: 3 });
  const guest = await server.connect(); await guest.send('join', { name: '朋友', roomId: host.session.roomId });
  const saved = host.saved();
  const offline = await guest.stateWhere(state => playerIn(state, saved.playerId)?.connected === false);
  assert.equal(playerIn(offline, saved.playerId).departurePending, false);
  await until(() => host.ws.readyState === WebSocket.CLOSED);
  const resumed = await server.connect(); await resumed.send('resume', saved); await delay(750);
  assert.equal(resumed.state.players.length, 2);
  assert.equal(playerIn(resumed.state, saved.playerId).connected, true);
  await resumed.action('start');
});

test('a replaced socket closing late cannot disconnect the resumed identity', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '250' } }), [host, guest] = await humans(server);
  const saved = host.saved(), replacement = await server.connect();
  await replacement.send('resume', saved);
  assert.equal(await host.closed, 4001);
  await delay(350);
  assert.equal(replacement.state.players.length, 2);
  assert.equal(playerIn(guest.state, saved.playerId).connected, true);
  await replacement.action('start');
});

test('a confirmed disconnected host leaves and the sole remaining player wins immediately', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '250' } }), [host, guest] = await humans(server, 2, 10);
  await host.action('start'); const saved = host.saved(); await host.disconnect();
  const ended = await guest.stateWhere(state => state.phase === 'finished');
  assert.equal(ended.round, 1); assert.equal(ended.finishReason, 'last-standing');
  assert.equal(ended.hostId, guest.session.playerId);
  assert.ok(ended.matchWinnerIds.includes(guest.session.playerId));
  assert.equal(ended.players.length, 1);
  assert.equal(ended.roundResult.players.find(player => player.id === saved.playerId).cost, 0);
  const expired = await server.connect();
  assert.ok(['PLAYER_REMOVED', 'SESSION_EXPIRED'].includes((await expired.send('resume', saved, true)).code));
});

for (const operation of ['imagine', 'price']) {
  test(`AI ${operation} failure stays private, appears as offline and leaves at the round boundary`, async t => {
    const server = await fixture(t), [host, guest] = await humans(server);
    await host.action('addBot'); const bot = host.state.players.find(player => player.bot);
    server.api.failNext(operation);
    await host.action('start');
    const offline = await host.stateWhere(state => playerIn(state, bot.id)?.departurePending === true);
    const failedMaterial = operation === 'price' ? server.api.requests.find(request => request.operation === 'price').data.material : null;
    assert.equal(playerIn(offline, bot.id).connected, false);
    assert.equal(offline.processingError, null);
    assert.ok(!host.messages.some(message => message.type === 'error'));
    assert.ok(!/PRIVATE_UPSTREAM|炼金顾问请求失败/.test(JSON.stringify(host.messages)));
    await Promise.all([prepare(host), prepare(guest, '干枯鼠尾草')]);
    const ended = await host.stateWhere(state => state.phase === 'roundEnd');
    assert.ok(!playerIn(ended, bot.id));
    assert.ok(ended.departedPlayers.some(player => player.id === bot.id));
    assert.equal(failedMaterial ? server.api.requests.filter(request => request.operation === 'price' && request.data.material === failedMaterial).length : server.api.count(operation), 1);
    await host.action('nextRound'); assert.equal(host.state.players.length, 2);
  });
}


test('expired resume still starts resolution when removing the final unprepared seat', async t => {
  const server = await fixture(t, { pauseIntervals: true, env: { RECONNECT_GRACE_MS: '150' } });
  const [host, guest, absent] = await humans(server, 3);
  await host.action('start');
  const first = await prepare(host, '晨露'), second = await prepare(guest, '干枯鼠尾草');
  const saved = absent.saved();
  await absent.disconnect();
  await guest.stateWhere(state => playerIn(state, saved.playerId)?.connected === false);
  await delay(220);

  const returning = await server.connect();
  assert.equal((await returning.send('resume', saved, true)).code, 'PLAYER_REMOVED');
  // Sweeps are paused: only the failed resume can start this computation.
  const performing = await host.stateWhere(state => state.phase === 'performing');
  assert.equal(playerIn(performing, host.session.playerId).coins, 20000 - first.price);
  assert.equal(playerIn(performing, guest.session.playerId).coins, 20000 - second.price);
  const syntheses = server.api.count('synthesize');
  assert.equal((await returning.send('resume', saved, true)).code, 'SESSION_EXPIRED');
  assert.equal(server.api.count('synthesize'), syntheses);
  assert.equal(host.state.me.coins, 20000 - first.price);
});
