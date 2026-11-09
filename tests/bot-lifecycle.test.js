import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, humans, prepare, until } from './helpers/live-server.js';

const names = ['窗边第一枚雨滴', '窗边第二枚雨滴'];
const nextChoice = data => data.game.me.quotes.length < 2
  ? { action: 'quote', name: names[data.game.me.quotes.length] }
  : { action: 'select', quoteId: data.game.me.quotes[1].id, strategy: { goal: '记住真实报价，再选第二份' } };

test('a successful second quote during the last human disconnection is remembered and resumed without duplicate work', async t => {
  const server = await fixture(t, {
    env: { RECONNECT_GRACE_MS: '4000' },
    responses: { imagine: nextChoice }, prices: { [names[0]]: 60, [names[1]]: 800 },
  });
  const [host] = await humans(server, 1);
  await host.action('addBot');
  const botId = host.state.players.find(player => player.bot).id, saved = host.saved();
  const held = server.api.holdMaterial(names[1]);
  await host.action('start'); await held.entered;
  assert.equal(server.api.count('imagine'), 2);
  await host.disconnect();
  held.release();
  await until(() => server.api.requests.some(request => request.data.material === names[1] && request.completedAt), 3000, 'successful quote while disconnected');
  await delay(100);
  assert.equal(server.api.count('imagine'), 2, 'No new decision should begin without a connected human');
  const resumed = await server.connect(); await resumed.send('resume', saved);
  assert.equal(resumed.state.players.find(player => player.id === botId).coins, 20000);
  // Prepare the human before the resumed bot's timer runs, so its select action
  // is the one that changes the phase to resolving.
  await prepare(resumed);
  const committed = await resumed.stateWhere(state => state.players.find(player => player.id === botId)?.ready);
  assert.ok(['resolving', 'performing'].includes(committed.phase));
  const calls = server.api.requests.filter(request => request.operation === 'imagine');
  assert.deepEqual(calls.map(request => request.data.game.me.quotes.length), [0, 1, 2]);
  assert.deepEqual(calls.map(request => request.data.decision.remainingSteps), [8, 7, 6]);
  assert.deepEqual(calls[2].data.memory.knownPrices.filter(item => item.source === 'own-quote').map(item => [item.name, item.price]), [[names[0], 60], [names[1], 800]]);
  for (const name of names) assert.equal(server.api.requests.filter(request => request.data.material === name).length, 1);
  const ended = await resumed.stateWhere(state => state.phase === 'roundEnd');
  assert.equal(ended.roundResult.players.find(player => player.id === botId).cost, 800);
  // Selection memory must survive the phase transition caused by the bot itself.
  await resumed.action('nextRound');
  await until(() => server.api.requests.some(request => request.operation === 'imagine' && request.data.game.round === 2), 3000, 'next-round memory');
  const next = server.api.requests.find(request => request.operation === 'imagine' && request.data.game.round === 2);
  assert.equal(next.data.memory.strategy.goal, '记住真实报价，再选第二份');
  assert.ok(next.data.memory.recentTurns.some(turn => turn.action === 'select' && turn.name === names[1]));
});

test('deleting a room during the second price request aborts it and a late result cannot trigger selection', async t => {
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '250' }, responses: { imagine: nextChoice } });
  const [host] = await humans(server, 1);
  await host.action('addBot');
  const saved = host.saved(), held = server.api.holdMaterial(names[1]);
  await host.action('start'); await held.entered;
  const pending = server.api.requests.find(request => request.data.material === names[1]);
  await host.disconnect();
  await until(() => pending.closedWithoutResponse, 3000, 'second price request cancellation');
  held.release(); await delay(100);
  assert.equal(server.api.count('imagine'), 2);
  assert.equal(server.api.count('price'), 2);
  const returning = await server.connect();
  assert.equal((await returning.send('resume', saved, true)).code, 'ROOM_CLOSED');
  await delay(100);
  assert.equal(server.api.count('imagine'), 2);
});
