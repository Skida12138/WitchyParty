import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GameRoom } from '../server/game.js';
import { materialVector, normalizeName, presets, reactionProbability, rules, tierFor } from '../server/alchemy.js';
import { FixtureAlchemyProvider } from './helpers/fixture-alchemy.js';
import { prepareRound, quoteAndReady, waitUntil } from './helpers/game-fixture.js';

function fixture(t, count = 2, options = {}) {
  const provider = Object.assign(new FixtureAlchemyProvider(), options.provider || {});
  const room = new GameRoom({ id: 'TEST', depositMs: 0, reactionMs: 0, holdMs: 0, random: () => 1, priceRandom: () => 0.99, ...options, provider });
  const players = Array.from({ length: count }, (_, index) => room.addPlayer('女巫' + (index + 1)));
  t.after(() => room.dispose());
  return { room, players, provider };
}
const play = (room, players, names = players.map(() => '晨露'), options) => prepareRound(room, players.map((player, index) => ({ player, name: names[index] })), options);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const reactionRandom = count => { let calls = 0; return () => ++calls < count ? 1 : 0; };

test('SHA-256 material vectors remain stable and reaction probability uses the unsquared distance', () => {
  const hash = createHash('sha256').update('月光蘑菇\0fixed-seed', 'utf8').digest();
  const expected = Array.from({ length: 4 }, (_, group) => {
    let sum = 0; for (let offset = 0; offset < 8; offset += 2) sum += hash.readUInt16BE(group * 8 + offset);
    return (sum % 65536) / 65535 * 2 - 1;
  });
  assert.deepEqual(materialVector('月光蘑菇', 'fixed-seed'), expected);
  assert.equal(reactionProbability('月光蘑菇', '月光蘑菇', 'fixed-seed'), 0);
  for (let index = 0; index < 100; index++) {
    const a = materialVector('材料' + index, 'fixed-seed'), b = materialVector('月光蘑菇', 'fixed-seed');
    const original = Math.min(1, Math.hypot(...a.map((value, i) => value - b[i])) / 2);
    assert.ok(Math.abs(reactionProbability('材料' + index, '月光蘑菇', 'fixed-seed') - original) < 1e-12);
  }
});

test('presets retain six tiers and default timing uses shorter chain holds than completion holds', () => {
  assert.equal(presets.length, 18);
  for (const tier of ['white', 'green', 'blue', 'purple', 'gold', 'red']) assert.equal(presets.filter(item => tierFor(item.price) === tier).length, 3);
  assert.deepEqual([0, 9, 10, 49, 50, 199, 200, 1999, 2000, 9999, 10000].map(tierFor), ['white', 'white', 'green', 'green', 'blue', 'blue', 'purple', 'purple', 'gold', 'gold', 'red']);
  assert.equal(normalizeName(' ＡＢＣ  '), 'ABC');
  assert.equal(rules.revealMs, undefined);
  assert.equal(rules.stirringMs, undefined);
  assert.equal(rules.depositMs, 1800);
  assert.equal(rules.reactionMs, 2400);
  assert.equal(rules.holdMs, 1500);
  assert.equal(rules.chainHoldMs, 1000);
  assert.equal(rules.winnerAnimationMs, 1200);
});

test('initial coins are the score and starting requires the host, two players, and an available provider', async t => {
  const { room, players: [a, b] } = fixture(t);
  assert.equal(a.coins, 20000); assert.equal(a.score, 20000);
  await assert.rejects(room.action(b.id, 'start'), /房主/);
  room.provider.ready = false;
  await assert.rejects(room.action(a.id, 'start'), /密钥/);
  room.provider.ready = true;
  room.removePlayer(b.id);
  await assert.rejects(room.action(a.id, 'start'), /至少/);
  assert.throws(() => new GameRoom({ rounds: 4 }), /轮数/);
});

test('independent simultaneous quotes stay private and same-name pricing shares one request', async t => {
  const held = deferred(); let calls = 0;
  const { room, players: [a, b] } = fixture(t, 2, { provider: { price: async () => { calls++; await held.promise; return { price: 300 }; } } });
  await room.action(a.id, 'start');
  const first = room.action(a.id, 'quote', { name: '茶杯里的秘密星云' });
  const second = room.action(b.id, 'quote', { name: '茶杯里的秘密星云' });
  await waitUntil(() => calls === 1);
  await assert.rejects(room.action(a.id, 'quote', { name: '另一份秘密' }), /正在处理/);
  held.resolve(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(a.coins, 20000);
  assert.equal(room.view(a.id).me.quotes[0].price, 300);
  assert.equal(room.view(a.id).players.find(player => player.id === b.id).quotes, undefined);
  assert.deepEqual(room.view(a.id).contributions, []);
  assert.deepEqual(room.view(a.id).pot, []);
});

test('three successful quotes, ready and unready are free; failed quotes consume no attempt', async t => {
  const { room, players: [a] } = fixture(t, 2, { provider: { price: async () => { throw new Error('upstream unavailable'); } } });
  await room.action(a.id, 'start');
  await assert.rejects(room.action(a.id, 'quote', { name: '价值999999金币的石头' }), /不能指定价值/);
  await assert.rejects(room.action(a.id, 'quote', { name: '暂时无法召唤的花' }), /upstream/);
  assert.equal(a.quotes.length, 0); assert.equal(a.quoteBusy, false);
  for (const name of ['晨露', '月光蘑菇', '一颗迷路的星星']) await room.action(a.id, 'quote', { name });
  await assert.rejects(room.action(a.id, 'quote', { name: '晨露' }), /三次/);
  await assert.rejects(room.action(a.id, 'commit', { quoteId: 'forged' }), /请选择/);
  await room.action(a.id, 'commit', { quoteId: a.quotes[0].id });
  await assert.rejects(room.action(a.id, 'quote', { name: '晨露' }), /取消准备/);
  await room.action(a.id, 'unready');
  await room.action(a.id, 'commit', { quoteId: a.quotes[2].id });
  assert.equal(a.coins, 20000); assert.equal(a.roundCost, 0);
  assert.equal(room.view(a.id).me.quotesRemaining, 0);
});

test('all ready atomically commits every material and deducts each cost once without a reveal phase', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { depositMs: 30 });
  const snapshots = [];
  room.on('change', () => snapshots.push(room.view(a.id)));
  await room.action(a.id, 'start');
  await quoteAndReady(room, a, '晨露');
  assert.equal(b.coins, 20000);
  assert.ok(!JSON.stringify(room.view(b.id)).includes('晨露'));
  await quoteAndReady(room, b, '月光蘑菇');
  assert.ok(['resolving', 'performing'].includes(room.phase));
  assert.deepEqual(room.contributions.map(card => card.price), [5, 25]);
  assert.deepEqual(room.players.map(player => player.coins), [19995, 19975]);
  for (const state of snapshots.filter(state => state.phase === 'preparing')) assert.deepEqual(state.contributions, []);
  assert.ok(snapshots.every(state => state.phase !== 'revealing'));
  for (const state of snapshots.filter(state => ['resolving', 'performing'].includes(state.phase))) {
    assert.equal(state.contributions.length, 2);
    assert.deepEqual(state.players.map(player => player.coins), [19995, 19975]);
  }
  await assert.rejects(room.action(a.id, 'commit', { quoteId: a.preparedQuoteId }), /备料/);
  await assert.rejects(room.action(a.id, 'unready'), /备料/);
  await waitUntil(() => room.phase === 'roundEnd');
  assert.equal(room.roundResult.reason, 'highest-contribution');
  assert.equal(room.roundResult.winnerId, b.id);
  assert.deepEqual(room.roundResult.players.map(row => row.cost), [5, 25]);
});

test('resolution waits only for the model and starts performance without reveal or artificial delay timers', async t => {
  const held = deferred(), started = deferred(), performing = deferred(), scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    scheduled.push(milliseconds);
    return originalSetTimeout(callback, milliseconds, ...args);
  });
  const { room, players: [a, b] } = fixture(t, 2, {
    depositMs: 100, reactionMs: 100, holdMs: 20, random: reactionRandom(2),
    provider: { synthesize: async () => { started.resolve(); await held.promise; return { name: '晨光茶晶' }; }, price: async () => ({ price: 300 }) },
  });
  room.on('change', () => { if (room.phase === 'performing') performing.resolve(); });
  await room.action(a.id, 'start');
  await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await started.promise;
  assert.equal(room.phase, 'resolving'); assert.equal(room.roundResult, null);
  assert.equal(room.presentation, null); assert.equal(room.deadline, null);
  assert.deepEqual(scheduled, [], 'There is no separate reveal timer or minimum computation wait');
  held.resolve(); await performing.promise;
  assert.deepEqual(scheduled, [120], 'The first scheduled timer ends the action and reading hold');
  const state = room.view(a.id);
  for (const field of ['revealingStartedAt', 'revealDurationMs', 'stirringDurationMs']) assert.equal(field in state, false);
  for (const field of ['revealMs', 'stirringMs']) assert.equal(field in state.rules, false);
});

test('the original highest contributor wins the final synthesized pot, without a decision phase', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { random: reactionRandom(2), provider: { synthesize: async () => ({ name: '清晨的金色旋律' }), price: async () => ({ price: 777 }) } });
  const phases = new Set(); room.on('change', () => phases.add(room.phase));
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇']);
  const result = room.roundResult;
  assert.equal(result.winnerId, b.id); assert.equal(result.potValue, 777);
  assert.deepEqual(result.contributions.map(card => card.price), [5, 25]);
  assert.equal(a.coins, 19995); assert.equal(b.coins, 20752); assert.equal(b.score, b.coins);
  assert.equal(result.players[1].delta, 752);
  assert.deepEqual([...phases], ['preparing', 'resolving', 'performing', 'roundEnd']);
  await assert.rejects(room.action(a.id, 'decision', { stay: true }), /未知/);
});

test('equal highest contributions use exactly one winner draw after successful calculation', async t => {
  let draws = 0;
  const { room, players: [a, b] } = fixture(t, 2, { random: () => { draws++; return 0; } });
  await room.action(a.id, 'start');
  await play(room, [a, b], ['一颗迷路的星星', '一颗迷路的星星']);
  assert.equal(draws, 2, 'One shuffle draw and one tied-winner draw; red materials do not react');
  assert.equal(room.roundResult.winnerId, b.id);
  assert.equal(room.roundResult.players.filter(row => row.winnings > 0).length, 1);
  assert.equal(b.coins, 32000); assert.equal(a.coins, 8000);
});

test('coins carry across rounds and final rankings use current balance without accumulated history', async t => {
  const { room, players: [a, b] } = fixture(t);
  await room.action(a.id, 'start');
  for (let round = 1; round <= 3; round++) {
    assert.equal(a.coins, 20000 - (round - 1) * 5);
    assert.equal(b.coins, 20000 + (round - 1) * 5);
    await play(room, [a, b], ['晨露', '月光蘑菇']);
    if (round < 3) await room.action(a.id, 'nextRound');
  }
  assert.equal(room.phase, 'finished'); assert.equal(room.finishReason, 'round-limit');
  assert.deepEqual(room.matchWinnerIds, [b.id]);
  assert.equal(a.score, 19985); assert.equal(b.score, 20015);
  const view = room.view(a.id);
  assert.equal(view.completedRounds, undefined);
  assert.ok(view.players.every(player => !('history' in player)));
  await assert.rejects(room.action(a.id, 'nextRound'), /当前/);
});

test('every round independently shuffles the original active roster and the public players follow it', async t => {
  const { room, players: [a, b, c] } = fixture(t, 3, { random: () => 0 });
  await room.action(a.id, 'start');
  const expected = [b.id, c.id, a.id];
  assert.deepEqual(room.turnOrder, expected);
  assert.deepEqual(room.view(a.id).players.map(player => player.id), expected);
  await play(room, [a, b, c], ['一颗迷路的星星', '一颗迷路的星星', '一颗迷路的星星']);
  await room.action(a.id, 'nextRound');
  assert.deepEqual(room.turnOrder, expected, 'A fresh permutation can repeat; it is not a rotating opener');
});

test('pot and contributions follow input order instead of price order', async t => {
  const { room, players } = fixture(t, 3);
  await room.action(players[0].id, 'start');
  await play(room, players, ['晨露', '一颗迷路的星星', '月光蘑菇']);
  assert.deepEqual(room.pot.map(card => card.price), [5, 12000, 25]);
  assert.deepEqual(room.view(players[0].id).pot.map(card => card.order), [0, 1, 2]);
  assert.deepEqual(room.roundResult.contributions.map(card => card.price), [5, 12000, 25]);
});

test('products inherit the earliest ingredient order and product pricing receives real source values', async t => {
  const pricing = [], ingredients = [];
  const { room, players } = fixture(t, 3, { random: reactionRandom(3), provider: {
    synthesize: async (a, b) => { ingredients.push([a, b]); return { name: '露珠蘑菇合奏' }; },
    price: async (name, context) => { pricing.push({ name, context }); return { price: 600 }; },
  } });
  await room.action(players[0].id, 'start');
  await play(room, players, ['晨露', '一颗迷路的星星', '月光蘑菇']);
  assert.deepEqual(room.pot.map(card => [card.price, card.order]), [[600, 0], [12000, 1]]);
  assert.deepEqual(ingredients[0].map(card => card.price), [5, 25]);
  assert.deepEqual(pricing[0].context.synthesisInputs, [{ name: '晨露', price: 5 }, { name: '月光蘑菇', price: 25 }]);
  assert.equal(room.roundResult.winnerId, players[1].id);
  assert.equal(room.roundResult.potValue, 12600);
});

test('ordinary quotes do not inherit product-pricing hints', async t => {
  const seen = [];
  const { room, players: [a] } = fixture(t, 2, { provider: { price: async (name, context) => { seen.push(context); return { price: 88 }; } } });
  await room.action(a.id, 'start'); await room.action(a.id, 'quote', { name: '被阳光晒暖的钥匙' });
  assert.equal(seen[0].synthesisInputs, undefined);
});

test('red inputs and newly red products stop reactions without changing visible input order', async t => {
  let syntheses = 0;
  const { room, players } = fixture(t, 3, { random: reactionRandom(3), provider: {
    synthesize: async () => { syntheses++; return { name: '整片星空的回声' }; }, price: async () => ({ price: 12000 }),
  } });
  await room.action(players[0].id, 'start'); await play(room, players, ['晨露', '月光蘑菇', '水晶蜘蛛丝']);
  assert.equal(syntheses, 1); assert.equal(room.pot.length, 2); assert.equal(room.pot[0].price, 12000);
  assert.ok(!JSON.stringify(room.view(players[0].id)).includes('"locked"'));
});

test('overdraft is permitted and the prize is applied before elimination', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { depositMs: 20, provider: { price: async () => ({ price: 25000 }) } });
  await room.action(a.id, 'start');
  await play(room, [a, b], ['整座云端茶室', '晨露'], { awaitResolution: false });
  assert.equal(a.coins, -5000); assert.equal(a.status, 'active');
  await waitUntil(() => room.phase === 'roundEnd');
  assert.equal(a.coins, 20005); assert.equal(a.status, 'active');
  assert.equal(room.roundResult.players[0].rawBalance, 20005);
});

test('a zero balance is eliminated permanently while two surviving players continue', async t => {
  const prices = { 漂流城堡: 20000, 云端王国: 30000 };
  const { room, players: [a, b, c] } = fixture(t, 3, { provider: { price: async name => ({ price: prices[name] }) } });
  await room.action(a.id, 'start'); await play(room, [a, b, c], ['漂流城堡', '云端王国', '晨露']);
  assert.equal(a.coins, 0); assert.equal(a.score, 0); assert.equal(a.status, 'eliminated');
  assert.equal(room.phase, 'roundEnd'); assert.equal(room.roundResult.players[0].eliminated, true);
  await room.action(a.id, 'nextRound');
  assert.equal(a.status, 'eliminated'); assert.ok(!room.turnOrder.includes(a.id));
  await assert.rejects(room.action(a.id, 'quote', { name: '晨露' }), /备料/);
  await play(room, [b, c], ['月光蘑菇', '晨露']);
  assert.equal(a.coins, 0); assert.equal(room.view(a.id).contributions.length, 2);
});

test('negative balances clamp to zero and one survivor immediately wins even a ten-round match', async t => {
  const prices = { 漂流城堡: 25000, 云端王国: 30000 };
  const { room, players: [a, b] } = fixture(t, 2, { rounds: 10, provider: { price: async name => ({ price: prices[name] }) } });
  await room.action(a.id, 'start'); await play(room, [a, b], ['漂流城堡', '云端王国']);
  const loss = room.roundResult.players[0];
  assert.equal(loss.rawBalance, -5000); assert.equal(loss.balance, 0); assert.equal(loss.delta, -20000);
  assert.equal(room.phase, 'finished'); assert.equal(room.round, 1);
  assert.equal(room.finishReason, 'last-standing'); assert.deepEqual(room.matchWinnerIds, [b.id]);
});

test('a severely devalued product can eliminate everyone and finish with no contender', async t => {
  const prices = { 暮色城堡: 9000, 暴雨花园: 8000, 空空的茶盏: 1 };
  const { room, players: [a, b] } = fixture(t, 2, { random: reactionRandom(2), priceRandom: () => 0.01, provider: {
    price: async name => ({ price: prices[name] }), synthesize: async () => ({ name: '空空的茶盏' }),
  } });
  a.coins = 1000; b.coins = 1000;
  await room.action(a.id, 'start'); await play(room, [a, b], ['暮色城堡', '暴雨花园']);
  assert.equal(room.roundResult.winnerId, a.id); assert.equal(room.roundResult.potValue, 1);
  assert.equal(room.phase, 'finished'); assert.equal(room.finishReason, 'no-contenders');
  assert.deepEqual(room.matchWinnerIds, []); assert.ok(room.players.every(player => player.coins === 0));
});

test('alchemy failure preserves AI contribution, costs, successful requests and random draws across retries', async t => {
  let calls = 0, failures = 2, draws = 0;
  const synthesisCalls = [], priceCalls = [];
  const { room, players: [a, b, c] } = fixture(t, 3, { random: () => ++draws < 3 ? 1 : 0, provider: {
    synthesize: async (first, second) => {
      calls++; synthesisCalls.push([first.name, second.name]);
      if ([first.name, second.name].includes('第一朵茶云')) {
        if (failures-- > 0) throw new Error('temporary synthesis failure');
        return { name: '第二朵茶云' };
      }
      return { name: '第一朵茶云' };
    },
    price: async name => { priceCalls.push(name); return { price: name === '第一朵茶云' ? 600 : 700 }; },
  } });
  c.bot = true;
  const performed = new Map();
  room.on('change', () => { if (room.presentation) performed.set(room.presentation.id, structuredClone(room.presentation)); });
  await room.action(a.id, 'start'); await play(room, [a, b, c], ['晨露', '月光蘑菇', '水晶蜘蛛丝']);
  assert.equal(room.phase, 'resolving'); assert.match(room.processingError, /synthesis/);
  assert.equal(c.departurePending, false); assert.equal(c.connected, true);
  const costs = room.players.map(player => player.roundCost), balances = room.players.map(player => player.coins);
  assert.deepEqual(costs, [5, 25, 80]); assert.deepEqual(balances, [19995, 19975, 19920]);
  assert.equal(room.pot.length, 0); assert.equal(room.contributions.length, 3); assert.equal(room.roundResult, null);
  assert.equal(room.presentation, null); assert.equal(performed.size, 0);
  const firstPlannedFrameId = room.resolutionBatch.plans[0].frames[0].id;
  const originalDraws = draws;
  await assert.rejects(room.action(b.id, 'retryCommit'), /房主/);
  await room.action(a.id, 'retryCommit'); await waitUntil(() => !!room.processingError && !room.busy);
  assert.equal(draws, originalDraws);
  await room.action(c.id, 'retryCommit'); await waitUntil(() => room.phase === 'roundEnd');
  assert.equal(draws, originalDraws);
  assert.equal(calls, 4); assert.deepEqual(priceCalls, ['第一朵茶云', '第二朵茶云']);
  assert.equal(synthesisCalls.filter(pair => !pair.includes('第一朵茶云')).length, 1);
  assert.deepEqual(room.roundResult.players.map(row => row.cost), costs);
  assert.equal(room.roundResult.potValue, 700);
  assert.equal(room.roundEvents.filter(event => event.kind === 'deposit').length, 3);
  assert.equal(performed.size, 5, 'Three deposits and two successful reactions play exactly once');
  assert.equal(performed.values().next().value.id, firstPlannedFrameId, 'Successful plans retain their frame identity across retry');
});

test('failed product pricing retries the price while keeping the successful recipe', async t => {
  let syntheses = 0, prices = 0;
  const { room, players: [a, b] } = fixture(t, 2, { random: reactionRandom(2), provider: {
    synthesize: async () => { syntheses++; return { name: '星光花茶' }; },
    price: async () => { if (++prices === 1) throw new Error('pricing unavailable'); return { price: 100 }; },
  } });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇']);
  assert.ok(room.processingError); await room.action(a.id, 'retryCommit');
  await waitUntil(() => room.phase === 'roundEnd');
  assert.equal(syntheses, 1); assert.equal(prices, 2); assert.equal(b.coins, 20075);
});

test('preparation departure invalidates a pending quote and never charges that player', async t => {
  const held = deferred();
  const { room, players: [a, b, c] } = fixture(t, 3, { provider: { price: async () => { await held.promise; return { price: 300 }; } } });
  await room.action(a.id, 'start');
  const pending = room.action(a.id, 'quote', { name: '还在路上的茶香' });
  await waitUntil(() => a.quoteBusy); room.markDeparting(a.id);
  assert.equal(room.hostId, b.id); assert.equal(a.coins, 20000); assert.equal(a.quotes.length, 0);
  assert.throws(() => room.setConnected(a.id, true), /已确认离场/);
  held.resolve(); await assert.rejects(pending, /已过期/);
  await play(room, [b, c]);
  assert.ok(!room.players.includes(a));
  assert.equal(room.roundResult.players.find(row => row.id === a.id).cost, 0);
  assert.equal(room.departedPlayers[0].score, 20000);
});

test('one preparer remaining ends immediately without charging or inventing contributions', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { rounds: 10 });
  await room.action(a.id, 'start'); await quoteAndReady(room, b, '月光蘑菇');
  room.markDeparting(a.id, { reason: 'leave' });
  assert.equal(room.phase, 'finished'); assert.equal(room.finishReason, 'last-standing');
  assert.deepEqual(room.matchWinnerIds, [b.id]); assert.equal(b.coins, 20000);
  assert.deepEqual(room.roundResult.contributions, []); assert.deepEqual(room.pot, []);
  assert.equal(room.roundResult.players.find(row => row.id === b.id).cost, 0);
});

test('short disconnection preserves the player and host; returning can reclaim a vacant host role', async t => {
  const { room, players: [a, b, c] } = fixture(t, 3);
  await room.action(a.id, 'start');
  room.setConnected(a.id, false); room.markDeparting(c.id);
  assert.equal(room.hostId, a.id); assert.equal(a.departurePending, false);
  room.setConnected(a.id, true); room.setConnected(b.id, false); room.markDeparting(a.id);
  assert.equal(room.hostId, null); room.setConnected(b.id, true);
  assert.equal(room.hostId, b.id); assert.equal(room.matchWinnerId, b.id);
});

test('a departed committed contributor still wins their round and is removed only at the boundary', async t => {
  const { room, players: [a, b, c] } = fixture(t, 3, { depositMs: 20 });
  await room.action(a.id, 'start'); await play(room, [a, b, c], ['晨露', '月光蘑菇', '一颗迷路的星星'], { awaitResolution: false });
  room.markDeparting(c.id);
  assert.ok(room.players.includes(c)); assert.equal(c.roundCost, 12000);
  await waitUntil(() => room.phase === 'roundEnd');
  assert.equal(room.roundResult.winnerId, c.id); assert.equal(c.coins, 20030);
  assert.ok(!room.players.includes(c)); assert.equal(room.departedPlayers[0].coins, 20030);
});

test('a committed paid round finishes before last-standing or no-contenders is declared', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { depositMs: 20 });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  room.markDeparting(a.id); room.markDeparting(b.id);
  assert.ok(['resolving', 'performing'].includes(room.phase));
  await waitUntil(() => room.phase === 'finished');
  assert.equal(room.finishReason, 'no-contenders'); assert.equal(room.roundResult.winnerId, b.id);
  assert.equal(room.roundResult.players.find(row => row.id === b.id).balance, 20005);
  assert.equal(room.players.length, 0); assert.equal(room.departedPlayers.length, 2);
});

test('disposing aborts pending synthesis and does not issue a later product-price request', async t => {
  const held = deferred(); let started = false, prices = 0;
  const { room, players: [a, b] } = fixture(t, 2, { random: reactionRandom(2), provider: {
    synthesize: async () => { started = true; await held.promise; return { name: '迟来的月亮' }; },
    price: async () => { prices++; return { price: 100 }; },
  } });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await waitUntil(() => started);
  const signal = room.aiTrace(a).signal; room.dispose(); assert.equal(signal.aborted, true);
  held.resolve(); await delay(10);
  assert.equal(prices, 0); assert.equal(room.roundResult, null);
  assert.deepEqual(room.players.map(player => player.coins), [19995, 19975], 'Already committed costs are not rolled back');
});

test('public results are immutable copies and the next round exposes no private new material', async t => {
  const { room, players: [a, b] } = fixture(t);
  await room.action(a.id, 'start'); await play(room, [a, b]);
  const result = room.view(a.id).roundResult;
  result.contributions[0].name = '外部篡改'; result.players[0].balance = 1;
  assert.equal(room.view(b.id).roundResult.contributions[0].name, '晨露');
  assert.notEqual(room.view(b.id).roundResult.players[0].balance, 1);
  await room.action(a.id, 'nextRound'); await room.action(b.id, 'quote', { name: '本轮秘密材料' });
  const state = room.view(a.id);
  assert.equal(state.roundResult, null); assert.deepEqual(state.contributions, []);
  assert.equal(state.completedRounds, undefined); assert.ok(!JSON.stringify(state).includes('本轮秘密材料'));
});

test('a final-round champion leaving does not promote the remaining player or rewrite the finish reason', async t => {
  const { room, players: [a, b] } = fixture(t);
  await room.action(a.id, 'start');
  for (let round = 1; round <= 3; round++) {
    await play(room, [a, b], ['晨露', '月光蘑菇']);
    if (round < 3) await room.action(a.id, 'nextRound');
  }
  assert.equal(room.matchWinnerId, b.id);
  assert.equal(room.finishReason, 'round-limit');
  room.markDeparting(b.id, { reason: 'leave' });
  const view = room.view(a.id);
  assert.equal(view.phase, 'finished');
  assert.equal(view.finishReason, 'round-limit');
  assert.equal(view.matchWinnerId, b.id);
  assert.deepEqual(view.matchWinnerIds, [b.id]);
  assert.equal(view.departedPlayers.find(player => player.id === b.id).coins, 20015);
  assert.equal(view.players[0].coins, 19985);
  assert.equal(view.roundResult.winnerId, b.id);
});

test('a last-standing champion remains the winner after leaving an eliminated spectator', async t => {
  const prices = { 漂流城堡: 25000, 云端王国: 30000 };
  const { room, players: [a, b] } = fixture(t, 2, { rounds: 10, provider: { price: async name => ({ price: prices[name] }) } });
  await room.action(a.id, 'start'); await play(room, [a, b], ['漂流城堡', '云端王国']);
  assert.equal(a.status, 'eliminated');
  assert.equal(room.finishReason, 'last-standing');
  room.markDeparting(b.id, { reason: 'disconnect' });
  assert.equal(room.view(a.id).matchWinnerId, b.id);
  assert.deepEqual(room.matchWinnerIds, [b.id]);
  assert.equal(room.finishReason, 'last-standing');
  room.markDeparting(a.id, { reason: 'leave' });
  assert.equal(room.players.length, 0);
  assert.deepEqual(room.matchWinnerIds, [b.id]);
  assert.equal(room.finishReason, 'last-standing');
});

test('precomputed deposit and chain-reaction frames play in order with stable cards and no early settlement', async t => {
  const draws = [1, 1, 1, 0, 0];
  let syntheses = 0, prices = 0;
  const { room, players: [a, b, c] } = fixture(t, 3, {
    depositMs: 8, reactionMs: 11, holdMs: 7, chainHoldMs: 3, random: () => draws.shift() ?? 0,
    provider: {
      synthesize: async () => ({ name: '午后的第' + (++syntheses) + '朵茶云' }),
      price: async () => ({ price: 500 + ++prices }),
    },
  });
  const snapshots = [];
  room.on('change', () => {
    if (room.phase === 'performing' && snapshots.at(-1)?.presentation.id !== room.presentation.id) snapshots.push({ ...room.view(a.id), synthesisCalls: syntheses, priceCalls: prices });
  });
  await room.action(a.id, 'start');
  await play(room, [a, b, c], ['晨露', '月光蘑菇', '水晶蜘蛛丝'], { awaitResolution: false });
  assert.deepEqual(room.pot, []);
  await waitUntil(() => room.phase === 'performing');
  await assert.rejects(room.action(a.id, 'nextRound'), /当前/);
  await assert.rejects(room.action(a.id, 'retryCommit'), /当前/);
  await waitUntil(() => room.phase === 'roundEnd');
  const frames = snapshots.map(state => state.presentation);
  assert.deepEqual(frames.map(frame => frame.kind), ['deposit', 'deposit', 'deposit', 'reaction', 'reaction']);
  assert.deepEqual(frames.map(frame => frame.playerId), [a.id, b.id, c.id, c.id, c.id]);
  assert.deepEqual(frames.map(frame => frame.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(frames.map(frame => frame.holdMs), [7, 7, 3, 3, 7], 'Only pauses within the same deposit and reaction chain are shortened');
  assert.ok(frames.every(frame => frame.total === 5));
  assert.equal(new Set(frames.map(frame => frame.id)).size, 5);
  assert.deepEqual(frames[0].potBefore, []);
  assert.ok(frames[0].startedAt >= room.resolvingStartedAt);
  const cardIds = cards => cards.map(card => card.id);
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index], state = snapshots[index];
    assert.equal(frame.animationMs, frame.kind === 'deposit' ? 8 : 11);
    assert.equal(frame.holdMs, index === 2 || index === 3 ? 3 : 7);
    assert.equal(frame.durationMs, frame.animationMs + frame.holdMs);
    assert.equal(state.deadline, frame.startedAt + frame.durationMs);
    assert.equal(state.turnPlayerId, frame.playerId);
    assert.equal(state.roundResult, null);
    assert.equal(state.synthesisCalls, 2); assert.equal(state.priceCalls, 2, 'All API calls complete before the first frame');
    assert.deepEqual(state.players.map(player => player.coins), [19995, 19975, 19920], 'The award waits for all frames');
    assert.deepEqual(cardIds(state.pot), cardIds(frame.potBefore));
    if (index > 0) assert.deepEqual(frame.potBefore, frames[index - 1].potAfter);
    const cards = [...frame.potBefore, ...frame.potAfter, ...(frame.ingredients || []), ...[frame.material, frame.product].filter(Boolean)];
    for (const card of cards) {
      assert.equal(typeof card.id, 'string'); assert.equal(typeof card.name, 'string');
      assert.equal(typeof card.price, 'number'); assert.equal(typeof card.order, 'number');
      assert.equal(card.tier, tierFor(card.price)); assert.ok('ownerId' in card);
    }
    if (frame.kind === 'deposit') {
      assert.equal(frame.material.id, room.contributions[index].id);
      assert.ok(frame.potAfter.some(card => card.id === frame.material.id));
    } else {
      assert.equal(frame.ingredients.length, 2);
      assert.ok(frame.ingredients.every(card => frame.potBefore.some(item => item.id === card.id)));
      assert.ok(frame.ingredients.every(card => !frame.potAfter.some(item => item.id === card.id)));
      assert.ok(frame.potAfter.some(card => card.id === frame.product.id));
    }
  }
  assert.ok(frames[4].ingredients.some(card => card.id === frames[3].product.id), 'The next chain link consumes the previous product');
  assert.deepEqual(room.pot, frames.at(-1).potAfter);
  assert.equal(room.roundResult.potValue, 502);
  assert.deepEqual(room.roundResult.products, [
    { name: '午后的第1朵茶云', price: 501, tier: 'purple' },
    { name: '午后的第2朵茶云', price: 502, tier: 'purple' },
  ], 'Public round knowledge includes intermediate products consumed by later reactions');
  assert.deepEqual(room.completedRounds[0].products, room.roundResult.products);
  assert.deepEqual(room.view(a.id).roundResult.products, room.roundResult.products);
  assert.equal(room.roundResult.winnerId, c.id);
  assert.equal(c.coins, 20422);
  assert.equal(room.presentation, null);
  assert.equal(room.view(a.id).presentation, null);
});

test('performing snapshots survive connection broadcasts and expose immutable current-frame timing', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { depositMs: 70 });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await waitUntil(() => room.phase === 'performing');
  const initial = room.view(a.id).presentation;
  room.setConnected(a.id, false); await delay(5); room.setConnected(a.id, true);
  const resumed = room.view(a.id).presentation;
  assert.equal(resumed.id, initial.id); assert.equal(resumed.index, initial.index);
  assert.equal(resumed.startedAt, initial.startedAt); assert.equal(resumed.durationMs, initial.durationMs);
  assert.ok(room.view(a.id).serverTime >= initial.startedAt + 5);
  resumed.material.name = '修改快照'; resumed.potAfter[0].price = 999;
  assert.equal(room.view(b.id).presentation.material.name, '晨露');
  assert.equal(room.view(b.id).presentation.potAfter[0].price, 5);
  await waitUntil(() => room.phase === 'roundEnd');
  assert.equal(room.view(a.id).presentation, null);
});

test('departure during performance keeps all paid frames and the contributor reward until the boundary', async t => {
  const { room, players: [a, b, c] } = fixture(t, 3, { depositMs: 20 });
  const frames = new Map();
  room.on('change', () => { if (room.presentation) frames.set(room.presentation.id, structuredClone(room.presentation)); });
  await room.action(a.id, 'start'); await play(room, [a, b, c], ['晨露', '月光蘑菇', '一颗迷路的星星'], { awaitResolution: false });
  await waitUntil(() => room.phase === 'performing');
  room.markDeparting(c.id, { reason: 'disconnect' });
  assert.ok(room.players.includes(c)); assert.equal(c.coins, 8000);
  assert.equal(room.roundResult, null);
  await waitUntil(() => room.phase === 'roundEnd');
  assert.deepEqual([...frames.values()].map(frame => frame.playerId), [a.id, b.id, c.id]);
  assert.equal(room.roundResult.winnerId, c.id); assert.equal(c.coins, 20030);
  assert.ok(!room.players.includes(c)); assert.equal(room.departedPlayers[0].coins, 20030);
});

test('disposing during performance cancels frame advancement and settlement', async t => {
  const { room, players: [a, b] } = fixture(t, 2, { depositMs: 40 });
  let frames = 0;
  room.on('change', () => { if (room.presentation) frames++; });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await waitUntil(() => room.phase === 'performing');
  const frameId = room.presentation.id;
  room.dispose(); await delay(70);
  assert.equal(frames, 1); assert.equal(room.presentation.id, frameId);
  assert.equal(room.roundResult, null); assert.deepEqual(room.pot, []);
  assert.deepEqual(room.players.map(player => player.coins), [19995, 19975]);
});

test('each deposit and reaction holds its completed cards and the final hold blocks settlement and next round', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const performing = deferred();
  const { room, players: [a, b] } = fixture(t, 2, {
    depositMs: 40, reactionMs: 60, holdMs: 200, chainHoldMs: 100, random: reactionRandom(2),
    provider: { synthesize: async () => ({ name: '月光里的茶晶' }), price: async () => ({ price: 100 }) },
  });
  room.on('change', () => { if (room.phase === 'performing') performing.resolve(); });
  await room.action(a.id, 'start');
  await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await performing.promise;
  const first = room.view(a.id).presentation;
  assert.equal(first.animationMs, 40); assert.equal(first.holdMs, 200); assert.equal(first.durationMs, 240);
  t.mock.timers.tick(40);
  assert.equal(room.presentation.id, first.id, 'The completed deposit remains the current frame throughout its hold');
  await assert.rejects(room.action(a.id, 'nextRound'), /当前/);
  t.mock.timers.tick(199);
  assert.equal(room.presentation.id, first.id); assert.equal(room.roundResult, null);
  t.mock.timers.tick(1);
  assert.equal(room.presentation.index, 1); assert.deepEqual(room.pot, first.potAfter);
  const second = room.view(a.id).presentation;
  assert.equal(second.holdMs, 100); assert.equal(second.durationMs, 140);
  t.mock.timers.tick(second.durationMs - 1);
  assert.equal(room.presentation.id, second.id); assert.equal(room.roundResult, null);
  t.mock.timers.tick(1);
  assert.equal(room.presentation.index, 2); assert.equal(room.presentation.kind, 'reaction');
  const reaction = room.view(a.id).presentation;
  assert.equal(reaction.animationMs, 60); assert.equal(reaction.holdMs, 200); assert.equal(reaction.durationMs, 260);
  t.mock.timers.tick(60);
  assert.equal(room.presentation.id, reaction.id); assert.equal(room.roundResult, null); assert.equal(b.coins, 19975);
  await assert.rejects(room.action(a.id, 'nextRound'), /当前/);
  t.mock.timers.tick(199);
  room.setConnected(a.id, false); room.setConnected(a.id, true);
  const resumed = room.view(a.id).presentation;
  assert.equal(resumed.id, reaction.id); assert.equal(resumed.startedAt, reaction.startedAt);
  assert.equal(resumed.animationMs, 60); assert.equal(resumed.holdMs, 200);
  assert.equal(room.phase, 'performing'); assert.equal(room.roundResult, null);
  t.mock.timers.tick(1);
  assert.equal(room.phase, 'roundEnd'); assert.equal(room.presentation, null);
  assert.equal(room.roundResult.winnerId, b.id); assert.equal(b.coins, 20075);
  assert.deepEqual(room.pot, reaction.potAfter);
});

test('winner celebration appears only after the final material hold and preserves the original contribution and completed backdrop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const performing = deferred();
  const { room, players: [a, b] } = fixture(t, 2, {
    depositMs: 40, reactionMs: 60, holdMs: 1500, chainHoldMs: 1000, random: reactionRandom(2),
    provider: { synthesize: async () => ({ name: '晨露凝成的小银铃' }), price: async () => ({ price: 100 }) },
  });
  room.on('change', () => { if (room.phase === 'performing') performing.resolve(); });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await performing.promise;
  const batch = room.resolutionBatch;
  assert.equal(batch.frames.length, 3, 'The celebration is not an extra server animation frame');
  assert.equal(room.view(a.id).roundResult, null); assert.equal(room.view(a.id).presentation.winner, undefined);
  t.mock.timers.tick(room.presentation.durationMs);
  t.mock.timers.tick(room.presentation.durationMs);
  const last = room.view(a.id).presentation;
  assert.equal(last.kind, 'reaction'); assert.equal(last.holdMs, 1500);
  assert.equal(last.product.name, '晨露凝成的小银铃'); assert.equal(last.product.price, 100);
  t.mock.timers.tick(last.durationMs - 1);
  assert.equal(room.presentation.id, last.id); assert.equal(room.roundResult, null); assert.equal(b.coins, 19975);
  assert.equal(room.completedRounds.length, 0);
  await assert.rejects(room.action(a.id, 'nextRound'), /当前/);
  t.mock.timers.tick(1);
  assert.equal(room.phase, 'roundEnd'); assert.equal(room.presentation, null);
  assert.equal(room.deadline, null); assert.equal(room.timer, null, 'There is no automatic celebration dismissal timer');
  const celebration = structuredClone(room.roundResult.winnerCelebration);
  assert.equal(typeof celebration.id, 'string'); assert.ok(celebration.id.length > 0);
  assert.equal(celebration.startedAt, last.startedAt + last.durationMs); assert.equal(celebration.animationMs, 1200);
  assert.deepEqual(celebration.winner, { id: b.id, name: b.name, bot: false, avatarIndex: 1 });
  assert.deepEqual(celebration.material, { name: '月光蘑菇', price: 25, tier: 'green', ownerId: b.id });
  assert.deepEqual(celebration.backdrop, last);
  assert.equal(room.roundResult.potValue, 100); assert.equal(b.coins, 20075);
  assert.deepEqual(room.completedRounds[0].winnerCelebration, celebration);

  const external = room.view(a.id).roundResult.winnerCelebration;
  external.id = 'modified'; external.winner.name = '篡改获胜者'; external.material.price = 999999;
  external.backdrop.product.name = '篡改背景'; external.backdrop.potAfter[0].price = 999999;
  assert.deepEqual(room.view(b.id).roundResult.winnerCelebration, celebration, 'Viewer snapshots cannot mutate the stored celebration');
  room.setConnected(a.id, false); t.mock.timers.tick(800); room.setConnected(a.id, true);
  assert.deepEqual(room.view(a.id).roundResult.winnerCelebration, celebration, 'Reconnect retains the same animation clock, identity and background');
  room._finishRound(batch); t.mock.timers.tick(5000);
  assert.equal(room.completedRounds.length, 1); assert.equal(b.coins, 20075);
  assert.deepEqual(room.roundResult.winnerCelebration, celebration);
  await room.action(a.id, 'nextRound');
  assert.equal(room.phase, 'preparing'); assert.equal(room.round, 2); assert.equal(room.view(a.id).roundResult, null);
});

test('a tied round draws its winner once at settlement and the celebration never substitutes the final match champion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let tieDraws = 0, allDraws = 0;
  const { room, players: [a, b] } = fixture(t, 2, {
    depositMs: 10, holdMs: 20,
    random: () => { allDraws++; if (room.phase === 'performing') { tieDraws++; return 0; } return 1; },
  });
  b.coins = 30000; b.score = b.coins;
  await room.action(a.id, 'start');
  for (let round = 1; round <= 3; round++) {
    const performing = deferred(), observe = () => { if (room.phase === 'performing') performing.resolve(); };
    room.on('change', observe);
    await play(room, [a, b], ['晨露', '晨露'], { awaitResolution: false });
    await performing.promise; room.off('change', observe);
    const batch = room.resolutionBatch;
    assert.equal(tieDraws, round - 1); assert.equal(room.roundResult, null);
    t.mock.timers.tick(room.presentation.durationMs);
    const last = room.view(a.id).presentation;
    t.mock.timers.tick(last.durationMs - 1);
    assert.equal(tieDraws, round - 1); assert.equal(room.view(a.id).roundResult, null);
    t.mock.timers.tick(1);
    const celebration = structuredClone(room.roundResult.winnerCelebration);
    assert.equal(tieDraws, round); assert.equal(allDraws, round * 3, 'Only seating, the nonreacting pair and the one tie draw consume randomness');
    assert.equal(room.roundResult.winnerId, a.id); assert.equal(celebration.winner.id, a.id);
    assert.equal(celebration.material.price, 5); assert.equal(room.roundResult.potValue, 10);
    assert.deepEqual(celebration.backdrop, last);
    room.setConnected(a.id, false); room.setConnected(a.id, true); room._finishRound(batch);
    assert.equal(tieDraws, round); assert.deepEqual(room.view(a.id).roundResult.winnerCelebration, celebration);
    if (round < 3) await room.action(a.id, 'nextRound');
  }
  assert.equal(room.phase, 'finished'); assert.equal(room.matchWinnerId, b.id);
  assert.equal(room.roundResult.winnerCelebration.winner.id, a.id);
  assert.equal(room.completedRounds.length, 3);
});

test('a departing original contributor keeps their winner snapshot and original avatar seat after removal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const performing = deferred();
  const { room, players: [a, b] } = fixture(t, 2, { depositMs: 10, holdMs: 20 });
  b.bot = true;
  room.on('change', () => { if (room.phase === 'performing') performing.resolve(); });
  await room.action(a.id, 'start'); await play(room, [a, b], ['晨露', '月光蘑菇'], { awaitResolution: false });
  await performing.promise;
  room.markDeparting(b.id, { reason: 'leave' });
  assert.ok(room.players.includes(b)); assert.equal(room.roundResult, null);
  t.mock.timers.tick(room.presentation.durationMs);
  const last = room.view(a.id).presentation;
  t.mock.timers.tick(last.durationMs);
  assert.equal(room.phase, 'finished'); assert.equal(room.matchWinnerId, a.id);
  assert.ok(!room.players.includes(b)); assert.equal(room.departedPlayers.find(player => player.id === b.id).coins, 20005);
  const celebration = structuredClone(room.roundResult.winnerCelebration);
  assert.deepEqual(celebration.winner, { id: b.id, name: b.name, bot: true, avatarIndex: 1 });
  assert.deepEqual(celebration.material, { name: '月光蘑菇', price: 25, tier: 'green', ownerId: b.id });
  assert.deepEqual(celebration.backdrop, last);
  assert.deepEqual(room.turnOrder, [a.id]);
  room.setConnected(a.id, false); t.mock.timers.tick(2000); room.setConnected(a.id, true);
  assert.deepEqual(room.view(a.id).roundResult.winnerCelebration, celebration);
});

test('a round ending before any contributions has no material-winner celebration', async t => {
  const { room, players: [a, b] } = fixture(t);
  await room.action(a.id, 'start'); await quoteAndReady(room, b, '月光蘑菇');
  room.markDeparting(b.id, { reason: 'leave' });
  assert.equal(room.phase, 'finished'); assert.equal(room.roundResult.reason, 'last-standing');
  assert.deepEqual(room.roundResult.contributions, []); assert.equal(room.roundResult.potValue, 0);
  assert.equal(room.roundResult.winnerCelebration, undefined); assert.equal(room.view(a.id).roundResult.winnerCelebration, undefined);
  assert.equal(room.presentation, null); assert.equal(room.timer, null);
});
