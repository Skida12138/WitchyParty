import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, humans, prepare, until } from './helpers/live-server.js';

const decisions = (server, id, round = 1) => server.api.requests.filter(request => request.operation === 'imagine' && request.data.game.me.id === id && request.data.game.round === round);
const select = (data, index = 0) => ({ action: 'select', quoteId: data.game.me.quotes[index].id });
const quote = name => ({ action: 'quote', name });
const seat = (state, id) => state.players.find(player => player.id === id);
async function addBots(host, count = 1) { for (let index = 0; index < count; index++) await host.action('addBot'); return host.state.players.filter(player => player.bot); }
async function ready(host, bots, round = 1) { return host.stateWhere(state => state.round === round && bots.every(bot => seat(state, bot.id)?.ready)); }

test('AI considers three real prices and selects the second candidate, charging only that material', async t => {
  const names = ['窗台上的小小月光', '藏在杯底的夏日雷声', '宇宙背面的一场旧梦'];
  const server = await fixture(t, {
    prices: { [names[0]]: 60, [names[1]]: 800, [names[2]]: 24000 },
    responses: { imagine: data => data.game.me.quotes.length < 3 ? { ...quote(names[data.game.me.quotes.length]), strategy: { goal: '看过价格后选择适合金币的中间候选' } } : select(data, 1) },
  });
  const [host, guest] = await humans(server), [bot] = await addBots(host);
  await host.action('start'); await ready(host, [bot]);
  const calls = decisions(server, bot.id);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(request => request.data.game.me.quotes.map(item => item.price)), [[], [60], [60, 800], [60, 800, 24000]]);
  assert.deepEqual(calls.map(request => request.data.decision.remainingQuotes), [3, 2, 1, 0]);
  assert.deepEqual(calls.map(request => request.data.decision.remainingSteps), [8, 7, 6, 5]);
  assert.deepEqual(calls.at(-1).data.decision.allowedActions, ['select']);
  assert.ok(calls.every(request => request.data.game.me.coins === 20000));
  assert.equal(seat(host.state, bot.id).coins, 20000);
  assert.ok(calls.at(-1).data.memory.knownPrices.some(item => item.name === names[2] && item.price === 24000 && item.source === 'own-quote'));
  await Promise.all([prepare(host), prepare(guest, '干枯鼠尾草')]);
  const ended = await host.stateWhere(state => state.phase === 'roundEnd');
  assert.equal(ended.contributions.find(item => item.ownerId === bot.id).name, names[1]);
  assert.equal(ended.roundResult.players.find(item => item.id === bot.id).cost, 800);
  assert.equal(decisions(server, bot.id).length, 4);
});

test('AI may reuse a reference material and stop after one successful cached candidate', async t => {
  const server = await fixture(t, { responses: { imagine: data => data.game.me.quotes.length ? select(data) : quote('晨露') } });
  const [host, guest] = await humans(server), [bot] = await addBots(host);
  await host.action('start'); await ready(host, [bot]);
  const calls = decisions(server, bot.id);
  assert.equal(calls.length, 2); assert.equal(server.api.count('price'), 0);
  assert.deepEqual(calls[1].data.game.me.quotes.map(item => [item.name, item.price]), [['晨露', 5]]);
  assert.ok(calls[1].data.memory.knownPrices.some(item => item.name === '晨露' && item.price === 5 && item.source === 'own-quote'));
  await Promise.all([prepare(host), prepare(guest)]);
  const ended = await host.stateWhere(state => state.phase === 'roundEnd');
  assert.equal(ended.roundResult.players.find(item => item.id === bot.id).cost, 5);
  assert.equal(decisions(server, bot.id).length, 2);
});

test('refused names, duplicate candidates and invalid selections consume steps but not the three success slots', async t => {
  let step = 0;
  const names = ['第一份可用的星屑', '第二份可用的花影', '第三份可用的风铃'];
  const refused = '会被模型拒绝的羽毛';
  const server = await fixture(t, { responses: {
    price: data => data.material === refused ? { refused: true, reason: 'PRIVATE_REFUSAL_DETAIL' } : { price: data.priceConstraint?.minPrice ?? 100 + names.indexOf(data.material) * 100 },
    imagine: data => {
      const sequence = [quote('价值99999的石头'), quote(refused), quote(names[0]), quote(names[0]), { action: 'select', quoteId: 'NOT_OWN_CURRENT_QUOTE' }, quote(names[1]), quote(names[2])];
      return ++step <= sequence.length ? sequence[step - 1] : select(data, 1);
    },
  } });
  const [host, guest] = await humans(server), [bot] = await addBots(host);
  await host.action('start'); await ready(host, [bot]);
  const calls = decisions(server, bot.id);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(request => request.data.decision.remainingSteps), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(calls.map(request => request.data.game.me.quotes.length), [0, 0, 0, 1, 1, 1, 2, 3]);
  assert.match(calls[1].data.decision.feedback, /拒绝|材料|指令/);
  assert.match(calls[2].data.decision.feedback, /拒绝|材料|指令/);
  assert.match(calls[4].data.decision.feedback, /本轮候选|已有|重复/);
  assert.match(calls[5].data.decision.feedback, /无效|候选|编号/);
  assert.deepEqual(calls[7].data.decision.allowedActions, ['select']);
  assert.equal(server.api.requests.filter(request => request.operation === 'price').length, 4);
  assert.equal(server.api.requests.filter(request => request.operation === 'price' && request.data.material === names[0]).length, 1);
  assert.ok(calls.every(request => request.data.game.me.coins === 20000));
  assert.ok(!JSON.stringify(calls.map(request => request.data)).includes('PRIVATE_REFUSAL_DETAIL'));
  assert.ok(calls.at(-1).data.memory.knownPrices.every(item => item.name !== refused));
  await Promise.all([prepare(host), prepare(guest)]);
  const ended = await host.stateWhere(state => state.phase === 'roundEnd');
  assert.equal(ended.roundResult.players.find(item => item.id === bot.id).cost, 200);
});

test('a bot cannot obtain a fourth candidate or get an automatic selection after exhausting all eight decisions', async t => {
  let counter = 0;
  const server = await fixture(t, { responses: { imagine: () => quote(`第${++counter}份不肯停下的云朵`) } });
  const [host, guest] = await humans(server), [bot] = await addBots(host);
  await host.action('start');
  const offline = await host.stateWhere(state => seat(state, bot.id)?.departurePending);
  assert.equal(seat(offline, bot.id).coins, 20000); assert.equal(seat(offline, bot.id).ready, false);
  const calls = decisions(server, bot.id);
  assert.equal(calls.length, 8); assert.equal(server.api.count('price'), 3);
  assert.ok(calls.slice(3).every(request => request.data.game.me.quotes.length === 3));
  assert.ok(calls.slice(3).every(request => JSON.stringify(request.data.decision.allowedActions) === '["select"]'));
  await delay(800); assert.equal(decisions(server, bot.id).length, 8, 'Background scheduling must not restart an exhausted round');
  await Promise.all([prepare(host), prepare(guest)]);
  const ended = await host.stateWhere(state => state.phase === 'roundEnd');
  assert.ok(ended.contributions.every(item => item.ownerId !== bot.id));
  assert.equal(ended.roundResult.players.find(item => item.id === bot.id).cost, 0);
  assert.ok(!/AI_DECISION_INVALID|炼金顾问/.test(JSON.stringify(host.messages.filter(message => message.type === 'error'))));
});

test('the last decision step is select-only even when just one candidate succeeded', async t => {
  let step = 0;
  const server = await fixture(t, { responses: { imagine: data => ++step === 1 ? quote('最后一步仍记得的桂花') : step < 8 ? { action: 'select', quoteId: 'INVALID_SELECTION' } : select(data) } });
  const [host] = await humans(server), [bot] = await addBots(host);
  await host.action('start'); await ready(host, [bot]);
  const calls = decisions(server, bot.id);
  assert.equal(calls.length, 8);
  assert.equal(calls.at(-1).data.game.me.quotes.length, 1);
  assert.equal(calls.at(-1).data.decision.remainingQuotes, 2);
  assert.equal(calls.at(-1).data.decision.remainingSteps, 1);
  assert.deepEqual(calls.at(-1).data.decision.allowedActions, ['select']);
  assert.equal(server.api.count('price'), 1);
});

test('disconnecting and resuming the last human does not reset a bot decision budget', async t => {
  let step = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const server = await fixture(t, { env: { RECONNECT_GRACE_MS: '4000' }, responses: { imagine: async () => {
    if (++step === 4) { enter(); await blocked; }
    return quote('价值99999的石头');
  } } });
  const [host] = await humans(server, 1), [bot] = await addBots(host), saved = host.saved();
  await host.action('start'); await entered;
  await host.disconnect(); release(); await delay(100);
  const resumed = await server.connect(); await resumed.send('resume', saved);
  await resumed.stateWhere(state => state.departedPlayers.some(player => player.id === bot.id));
  const calls = decisions(server, bot.id);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(request => request.data.decision.remainingSteps), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(server.api.count('price'), 0);
  await delay(800); assert.equal(decisions(server, bot.id).length, 8);
});

test('cross-round memory retains own unselected prices and every public reaction product without exposing private candidates', async t => {
  const privateNames = ['只属于第一位女巫的秘密贝壳', '只属于第二位女巫的秘密丝带'];
  const chosenNames = ['第一位女巫公开投入的风车', '第二位女巫公开投入的露灯'];
  const productNames = ['连锁反应中途消耗的月影结晶', '连锁反应最终留下的花雨结晶'];
  const humanSecret = '真人永不投入的私密松果';
  const prices = {
    [privateNames[0]]: 1200, [privateNames[1]]: 1300,
    [chosenNames[0]]: 200, [chosenNames[1]]: 300,
    [productNames[0]]: 550, [productNames[1]]: 650, [humanSecret]: 911,
  };
  const botIndexes = new Map(), oldQuoteIds = new Map(), nextRoundSteps = new Map(), productPrices = new Map();
  let productIndex = 0;
  const server = await fixture(t, {
    env: { NODE_OPTIONS: '--import=./tests/helpers/chain-reaction-random.js' }, prices,
    responses: {
      price: (data, _request, requests) => {
        let price = prices[data.material] + (privateNames.includes(data.material) && requests.filter(request => request.operation === 'price' && request.data.material === data.material).length > 1 ? 17 : 0);
        if (data.priceConstraint) {
          price = Math.max(data.priceConstraint.minPrice, Math.min(data.priceConstraint.maxPrice, price));
          productPrices.set(data.material, price);
        }
        return { price };
      },
      synthesize: () => ({ name: productNames[productIndex++] }),
      imagine: data => {
        const id = data.game.me.id, index = botIndexes.get(id), candidates = data.game.me.quotes;
        if (data.game.round === 1) {
          if (candidates.length === 0) return quote(privateNames[index]);
          if (candidates.length === 1) return quote(chosenNames[index]);
          oldQuoteIds.set(id, candidates[0].id);
          return select(data, 1);
        }
        const step = (nextRoundSteps.get(id) || 0) + 1;
        nextRoundSteps.set(id, step);
        if (step === 1 || step === 3) return { action: 'select', quoteId: oldQuoteIds.get(id) };
        if (step === 2) return quote(privateNames[index]);
        return select(data);
      },
    },
  });
  const [host] = await humans(server, 1), bots = await addBots(host, 2);
  bots.forEach((bot, index) => botIndexes.set(bot.id, index));
  const held = server.api.hold('imagine');
  await host.action('start'); await held.entered;
  await host.action('quote', { name: humanSecret });
  held.release(); await ready(host, bots);
  for (const bot of bots) assert.equal(decisions(server, bot.id).length, 3);
  await prepare(host);
  const ended = await host.stateWhere(state => state.phase === 'roundEnd');
  assert.equal(server.api.count('synthesize'), 2);
  assert.equal(productPrices.size, 2);
  assert.deepEqual(ended.roundResult.products.map(item => [item.name, item.price]), productNames.map(name => [name, productPrices.get(name)]));
  assert.deepEqual(ended.pot.map(item => item.name), [productNames[1]]);
  const reactions = [...new Map(host.messages.filter(message => message.state?.presentation?.kind === 'reaction').map(message => [message.state.presentation.id, message.state.presentation])).values()];
  assert.equal(reactions.length, 2);
  assert.equal(reactions[0].playerId, reactions[1].playerId, 'Both reactions belong to the same incoming material');
  assert.ok(reactions[1].ingredients.some(item => item.id === reactions[0].product.id), 'The intermediate product is consumed by the next link');

  await host.action('nextRound'); await ready(host, bots, 2);
  for (const [index, bot] of bots.entries()) {
    const calls = decisions(server, bot.id, 2), memory = calls[0].data.memory;
    assert.equal(calls.length, 4);
    assert.ok(memory.knownPrices.some(item => item.name === privateNames[index] && item.price === prices[privateNames[index]] && item.round === 1 && item.source === 'own-quote'));
    for (const name of ['晨露', ...chosenNames]) {
      assert.ok(memory.knownPrices.some(item => item.name === name && item.price === (prices[name] ?? 5) && item.round === 1 && item.source === 'public-contribution'));
    }
    for (const name of productNames) assert.ok(memory.knownPrices.some(item => item.name === name && item.price === productPrices.get(name) && item.round === 1 && item.source === 'public-product'));
    assert.deepEqual(memory.roundSummaries[0].products, ended.roundResult.products);
    assert.deepEqual(calls.map(request => request.data.game.me.quotes.length), [0, 0, 1, 1]);
    assert.deepEqual(calls.map(request => request.data.decision.remainingQuotes), [3, 3, 2, 2]);
    assert.deepEqual(calls.map(request => request.data.decision.remainingSteps), [8, 7, 6, 5]);
    assert.match(calls[1].data.decision.feedback, /无效|候选|编号/);
    assert.match(calls[3].data.decision.feedback, /无效|候选|编号/);
    const currentQuote = calls[3].data.game.me.quotes[0];
    assert.equal(currentQuote.name, privateNames[index]);
    assert.equal(currentQuote.price, prices[privateNames[index]] + 17, 'The new server quote takes precedence over last round\'s remembered price');
    assert.notEqual(currentQuote.id, oldQuoteIds.get(bot.id), 'Reusing a known material requires a fresh quote in this round');
    assert.equal(server.api.requests.filter(request => request.operation === 'price' && request.data.material === privateNames[index]).length, 2, 'A remembered price does not bypass new-round pricing');
    assert.ok(calls[3].data.memory.knownPrices.some(item => item.name === privateNames[index] && item.price === prices[privateNames[index]] + 17 && item.round === 2 && item.source === 'own-quote'));
    assert.equal(seat(host.state, bot.id).coins, seat(ended, bot.id).coins, 'New-round preparation does not spend gold');
    for (const request of [...decisions(server, bot.id), ...calls]) {
      const payload = JSON.stringify(request.data);
      assert.ok(!payload.includes(privateNames[1 - index]), 'Another bot cannot see this bot\'s unselected material');
      assert.ok(!payload.includes(humanSecret), 'Human unselected materials never enter bot decisions or memory');
    }
  }
  for (const name of privateNames) assert.ok(!JSON.stringify(host.messages).includes(name), 'A bot\'s private candidates remain hidden from human players before reveal');
  assert.ok(!JSON.stringify(ended.roundResult).includes(humanSecret));
});
