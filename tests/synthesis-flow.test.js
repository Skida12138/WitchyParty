import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/game.js';
import { rules } from '../server/alchemy.js';
import { prepareRound, waitUntil } from './helpers/game-fixture.js';

const pair = [{ name: '晨露', price: 5 }, { name: '月光蘑菇', price: 25 }];
const snapshot = value => structuredClone(value);

// Reaction rolls are separate from the pricing lottery. The first count - 1
// rolls preserve seating order; subsequent rolls explicitly allow or skip pairs.
function fixture(t, { count = 2, reactionRolls = [0], priceDraws = [0.5], synthesize, price } = {}) {
  const calls = { syntheses: [], prices: [], events: [], priceDraws: [], reactionDraws: [] };
  let randomIndex = 0, priceIndex = 0;
  const provider = {
    ready: true, mode: 'test',
    async synthesize(first, second, context) {
      const request = { inputs: snapshot([first, second]), context: snapshot(context) };
      calls.syntheses.push(request);
      return synthesize(request, calls);
    },
    async price(name, context) {
      const request = { name, context: snapshot(context) };
      calls.prices.push(request);
      return price(request, calls);
    },
    recordEvent(_trace, event) { calls.events.push(snapshot(event)); },
  };
  const room = new GameRoom({
    id: 'SYNTHESIS-FLOW', provider, depositMs: 0, reactionMs: 0, holdMs: 0,
    random: () => {
      const index = randomIndex++;
      const draw = index < count - 1 ? 1 : reactionRolls[index - (count - 1)] ?? 1;
      calls.reactionDraws.push(draw);
      return draw;
    },
    priceRandom: () => {
      const draw = priceDraws[priceIndex++];
      calls.priceDraws.push(draw);
      assert.notEqual(draw, undefined, 'Each expected actual reaction has exactly one configured price draw');
      return draw;
    },
  });
  const players = Array.from({ length: count }, (_, index) => room.addPlayer(`区间女巫${index + 1}`));
  const frames = new Map();
  room.on('change', () => { if (room.presentation) frames.set(room.presentation.id, snapshot(room.presentation)); });
  t.after(() => room.dispose());
  return { room, players, calls, frames };
}

async function play(room, players, names = ['晨露', '月光蘑菇']) {
  await room.action(players[0].id, 'start');
  await prepareRound(room, players.map((player, index) => ({ player, name: names[index] })));
}

async function retry(room, player) {
  await room.action(player.id, 'retryCommit');
  await waitUntil(() => ['roundEnd', 'finished'].includes(room.phase) || room.processingError && !room.busy, { label: 'synthesis retry completion' });
}

function assertBlocked(room, players, frames, prices) {
  assert.equal(room.phase, 'resolving'); assert.ok(room.processingError); assert.equal(room.busy, false);
  assert.equal(room.presentation, null); assert.equal(room.roundResult, null); assert.deepEqual(room.pot, []);
  assert.equal(frames.size, 0, 'No frames play until every required model result is valid');
  assert.deepEqual(players.map(player => player.roundCost), prices);
  assert.deepEqual(players.map(player => player.coins), prices.map(value => rules.startingCoins - value));
}

for (const scenario of [
  { band: 'below', draw: 0.01, minPrice: 0, maxPrice: 4, resultPrice: 2 },
  { band: 'between', draw: 0.5, minPrice: 5, maxPrice: 25, resultPrice: 18 },
  { band: 'above', draw: 0.99, minPrice: 26, maxPrice: rules.maxMaterialPrice, resultPrice: 70 },
]) {
  test(`a real ${scenario.band} reaction passes the same sorted inputs and price interval through naming and pricing`, async t => {
    const expected = { band: scenario.band, minPrice: scenario.minPrice, maxPrice: scenario.maxPrice };
    const { room, players, calls, frames } = fixture(t, {
      priceDraws: [scenario.draw],
      synthesize: async () => ({ name: '茶盏边缘的小回声', price: 999999 }),
      price: async () => ({ price: scenario.resultPrice }),
    });
    await play(room, players);
    assert.equal(room.phase, 'roundEnd'); assert.equal(room.processingError, null);
    assert.deepEqual(calls.priceDraws, [scenario.draw]);
    assert.equal(calls.syntheses.length, 1); assert.equal(calls.prices.length, 1);
    assert.deepEqual(calls.syntheses[0].inputs, pair, 'The expensive incoming material is sorted after its cheaper partner');
    assert.deepEqual(calls.prices[0].context.synthesisInputs, pair);
    assert.deepEqual(calls.syntheses[0].context.priceConstraint, expected);
    assert.deepEqual(calls.prices[0].context.priceConstraint, expected);
    assert.equal(calls.events.filter(event => event.type === 'synthesis_price_draw').length, 1);
    assert.equal(room.roundResult.potValue, scenario.resultPrice);
    assert.deepEqual(room.roundResult.products.map(product => product.price), [scenario.resultPrice]);
    assert.equal(room.roundResult.winnerId, players[1].id);
    assert.deepEqual(room.roundResult.players.map(player => player.cost), [5, 25]);
    assert.equal(players[1].coins, rules.startingCoins - 25 + scenario.resultPrice);
    assert.deepEqual([...frames.values()].map(frame => frame.kind), ['deposit', 'deposit', 'reaction']);
  });
}

test('an out-of-interval product price blocks playback and retries only its price with the original draw and charge', async t => {
  const { room, players, calls, frames } = fixture(t, {
    priceDraws: [0.5],
    synthesize: async () => ({ name: '藏在茶香里的银铃' }),
    price: async (_request, observed) => ({ price: observed.prices.length === 1 ? 26 : 20 }),
  });
  await play(room, players);
  assertBlocked(room, players, frames, [5, 25]);
  assert.match(room.processingError, /价格不在本次允许区间/);
  const pending = room.pendingCommit, policies = snapshot(pending.pricingPolicies), reactionDrawCount = calls.reactionDraws.length;
  assert.equal(pending.synthesis.size, 1, 'Successful naming is retained even though pricing failed');
  assert.equal(pending.prices.has('藏在茶香里的银铃'), false, 'An invalid price is neither cached nor clamped');
  assert.equal(room.priceCache.has('藏在茶香里的银铃'), false);
  assert.deepEqual(policies[0].priceConstraint, { band: 'between', minPrice: 5, maxPrice: 25 });
  await retry(room, players[0]);
  assert.equal(room.phase, 'roundEnd'); assert.equal(room.processingError, null);
  assert.deepEqual(calls.priceDraws, [0.5]); assert.equal(calls.reactionDraws.length, reactionDrawCount);
  assert.deepEqual(pending.pricingPolicies, policies); assert.equal(calls.syntheses.length, 1); assert.equal(calls.prices.length, 2);
  assert.deepEqual(calls.prices.map(request => request.context.priceConstraint), [policies[0].priceConstraint, policies[0].priceConstraint]);
  assert.equal(room.priceCache.get('藏在茶香里的银铃').price, 20);
  assert.deepEqual(room.roundResult.players.map(player => player.cost), [5, 25]);
  assert.deepEqual(players.map(player => player.coins), [19995, 19995]);
  assert.equal(room.roundResult.potValue, 20); assert.equal(frames.size, 3);
});

test('a synthesis name colliding with an out-of-interval preset is rejected before recipe caching and keeps the same draw on rename', async t => {
  const { room, players, calls, frames } = fixture(t, {
    priceDraws: [0.99],
    synthesize: async (_request, observed) => ({ name: observed.syntheses.length === 1 ? '晨露' : '晨露中醒来的风铃' }),
    price: async () => ({ price: 75 }),
  });
  await play(room, players);
  assertBlocked(room, players, frames, [5, 25]);
  assert.match(room.processingError, /价格不在本次允许区间/);
  const pending = room.pendingCommit, policy = snapshot(pending.pricingPolicies[0]);
  assert.equal(calls.prices.length, 0, 'The incompatible cached price is not sent for repricing');
  assert.equal(pending.synthesis.size, 0); assert.equal(room.synthesisCache.size, 0);
  assert.equal(pending.prices.get('晨露').price, 5); assert.equal(room.priceCache.get('晨露').price, 5);
  await retry(room, players[0]);
  assert.equal(room.phase, 'roundEnd'); assert.equal(calls.syntheses.length, 2); assert.equal(calls.prices.length, 1);
  assert.deepEqual(calls.priceDraws, [0.99]); assert.deepEqual(pending.pricingPolicies[0], policy);
  assert.deepEqual(calls.syntheses.map(request => request.context.priceConstraint), [policy.priceConstraint, policy.priceConstraint]);
  assert.deepEqual(calls.syntheses[1].context.history, [], 'The rejected name never became a reusable recipe');
  assert.equal(room.priceCache.get('晨露').price, 5); assert.equal(room.priceCache.get('晨露中醒来的风铃').price, 75);
  assert.equal(room.synthesisCache.size, 1);
  assert.equal([...room.synthesisCache.values()][0].name, '晨露中醒来的风铃');
  assert.deepEqual(room.roundResult.players.map(player => player.cost), [5, 25]); assert.equal(frames.size, 3);
});

test('repeated real reactions separate recipes by price interval while reusing an earlier compatible recipe', async t => {
  const { room, players, calls } = fixture(t, {
    count: 6,
    // React each fresh mushroom with a fresh dew, skipping the cheap product
    // left in the pot. The expensive product is red and cannot react again.
    reactionRolls: [0, 1, 1, 0, 1, 1, 0, 1], priceDraws: [0.01, 0.99, 0.02],
    synthesize: async request => ({ name: request.context.priceConstraint.band === 'below' ? '茶杯口的一缕薄雾' : '照亮星穹的茶盏' }),
    price: async request => ({ price: request.name === '茶杯口的一缕薄雾' ? 2 : 10000 }),
  });
  await play(room, players, ['晨露', '月光蘑菇', '晨露', '月光蘑菇', '晨露', '月光蘑菇']);
  assert.equal(room.phase, 'roundEnd'); assert.equal(room.processingError, null);
  assert.deepEqual(calls.priceDraws, [0.01, 0.99, 0.02], 'A compatible cache hit still uses this actual reaction\'s one lottery draw');
  assert.equal(calls.syntheses.length, 2); assert.equal(calls.prices.length, 2);
  assert.deepEqual(calls.syntheses.map(request => request.inputs), [pair, pair]);
  assert.deepEqual(calls.syntheses.map(request => request.context.priceConstraint.band), ['below', 'above']);
  assert.equal(room.synthesisCache.size, 2, 'One material pair keeps separate recipes for its different permitted intervals');
  assert.equal(new Set(room.synthesisCache.keys()).size, 2);
  assert.deepEqual([...room.synthesisCache.values()].map(recipe => recipe.priceConstraint.band).sort(), ['above', 'below']);
  const lottery = calls.events.filter(event => event.type === 'synthesis_price_draw');
  assert.deepEqual(lottery.map(event => event.request.priceConstraint.band), ['below', 'above', 'below']);
  assert.equal(calls.events.filter(event => event.type === 'cache_hit' && event.operation === 'synthesize').length, 1);
  assert.deepEqual(room.roundResult.products.map(product => product.name), ['茶杯口的一缕薄雾', '照亮星穹的茶盏', '茶杯口的一缕薄雾']);
  assert.deepEqual(room.roundResult.products.map(product => product.price), [2, 10000, 2]);
  assert.equal(room.roundResult.potValue, 10004);
  assert.equal(room.priceCache.get('茶杯口的一缕薄雾').price, 2);
  assert.equal(room.priceCache.get('照亮星穹的茶盏').price, 10000);
});

test('each link in one reaction chain keeps its own pricing draw when a later product needs a retry', async t => {
  const { room, players, calls, frames } = fixture(t, {
    count: 3, reactionRolls: [1, 0, 0], priceDraws: [0.01, 0.99],
    synthesize: async request => ({ name: request.context.priceConstraint.band === 'below' ? '将散的茶烟' : '茶烟凝成的月铃' }),
    price: async (request, observed) => ({ price: request.name === '将散的茶烟' ? 2 : observed.prices.filter(item => item.name === request.name).length === 1 ? 10 : 100 }),
  });
  await play(room, players, ['晨露', '月光蘑菇', '水晶蜘蛛丝']);
  assertBlocked(room, players, frames, [5, 25, 80]);
  const pending = room.pendingCommit, policies = snapshot(pending.pricingPolicies), reactionDrawCount = calls.reactionDraws.length;
  const firstProductId = pending.productIds[0];
  assert.equal(pending.contribution.ownerId, players[2].id);
  assert.deepEqual(policies.map(policy => policy.draw), [0.01, 0.99]);
  assert.deepEqual(policies.map(policy => policy.priceConstraint), [
    { band: 'below', minPrice: 0, maxPrice: 4 },
    { band: 'above', minPrice: 26, maxPrice: rules.maxMaterialPrice },
  ]);
  assert.deepEqual(calls.syntheses.map(request => request.inputs), [
    [{ name: '晨露', price: 5 }, { name: '水晶蜘蛛丝', price: 80 }],
    [{ name: '将散的茶烟', price: 2 }, { name: '月光蘑菇', price: 25 }],
  ]);
  assert.equal(pending.prices.get('将散的茶烟').price, 2); assert.equal(pending.prices.has('茶烟凝成的月铃'), false);
  await retry(room, players[0]);
  assert.equal(room.phase, 'roundEnd'); assert.equal(room.processingError, null);
  assert.deepEqual(calls.priceDraws, [0.01, 0.99]); assert.equal(calls.reactionDraws.length, reactionDrawCount);
  assert.deepEqual(pending.pricingPolicies, policies); assert.equal(pending.productIds[0], firstProductId);
  assert.equal(calls.events.filter(event => event.type === 'synthesis_price_draw').length, 2);
  assert.equal(calls.syntheses.length, 2, 'Both successful names are reused during the retry');
  assert.deepEqual(calls.prices.map(request => request.name), ['将散的茶烟', '茶烟凝成的月铃', '茶烟凝成的月铃']);
  assert.deepEqual(calls.prices.map(request => request.context.priceConstraint), [policies[0].priceConstraint, policies[1].priceConstraint, policies[1].priceConstraint]);
  assert.deepEqual(calls.prices.map(request => request.context.synthesisInputs), [policies[0].inputs, policies[1].inputs, policies[1].inputs]);
  assert.deepEqual(room.roundResult.products.map(product => product.price), [2, 100]);
  assert.deepEqual(room.roundResult.players.map(player => player.cost), [5, 25, 80]);
  assert.equal(players[2].coins, 20020); assert.equal(room.roundResult.potValue, 100);
  const reactions = [...frames.values()].filter(frame => frame.kind === 'reaction');
  assert.equal(frames.size, 5); assert.equal(reactions.length, 2);
  assert.equal(reactions[0].product.id, firstProductId);
  assert.ok(reactions[1].ingredients.some(ingredient => ingredient.id === firstProductId));
});
