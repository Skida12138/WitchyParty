import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentMemoryStore, normalizeStrategy, privateMemoryContext, publicRoundSummary } from '../server/agent-memory.js';

const identity = { roomSessionId: 'room-session', playerId: 'witch-a', round: 1, phase: 'preparing', persona: '沉着而幽默' };
const turn = { operation: 'imagine', name: '杯中的微光', strategy: { goal: '等待机会', risk: 'balanced' } };
const round = number => ({ round: number, winnerId: 'witch-a', potValue: 150, contributions: [{ ownerId: 'witch-a', name: '微光', price: 100 }], players: [{ id: 'witch-a', name: '甲', before: 20000, cost: 100, winnings: 150, rawBalance: 20050, balance: 20050, delta: 50, eliminated: false }] });
const quote = (name = '杯中的微光', amount = 100, id = 'quote-a') => ({ operation: 'imagine', action: 'quote', quoteId: id, name, price: amount, tier: 'blue', strategy: { goal: '比较几份灵感', risk: 'balanced' } });

test('memory is isolated by room session and player, with immutable caller snapshots', () => {
  const store = new AgentMemoryStore(), first = store.begin(identity);
  assert.equal(store.commit(first.token, turn), true);
  const own = store.begin(identity), other = store.begin({ ...identity, playerId: 'witch-b', persona: '热情' }), reusedCode = store.begin({ ...identity, roomSessionId: 'new-session' });
  assert.equal(own.memory.strategy.goal, '等待机会');
  assert.deepEqual(other.memory.strategy, {}); assert.deepEqual(reusedCode.memory.strategy, {});
  own.memory.strategy.goal = 'mutated'; own.memory.recentTurns[0].name = 'mutated';
  const snapshot = store.snapshot(identity.roomSessionId, identity.playerId);
  assert.equal(snapshot.strategy.goal, '等待机会'); assert.equal(snapshot.recentTurns[0].name, turn.name);
  assert.equal(other.memory.persona, '热情');
});

test('only a successful current imagination commit advances memory, exactly once', () => {
  const store = new AgentMemoryStore(), initial = store.begin(identity);
  assert.deepEqual(Object.keys(initial).sort(), ['memory', 'token']);
  assert.equal(store.snapshot(identity.roomSessionId, identity.playerId).revision, 0);
  assert.equal(store.commit(initial.token, turn, { isCurrent: () => false }), false);
  assert.equal(store.commit(initial.token, turn), false);
  const retry = store.begin(identity);
  assert.equal(store.commit(retry.token, turn), true); assert.equal(store.commit(retry.token, turn), false);
  const snapshot = store.snapshot(identity.roomSessionId, identity.playerId);
  assert.equal(snapshot.revision, 1); assert.equal(snapshot.recentTurns.length, 1);
  assert.equal(snapshot.cursor, undefined); assert.equal(snapshot.chat, undefined);
});

test('concurrent, cross-round and removed-player responses cannot overwrite newer memory', () => {
  const store = new AgentMemoryStore(), a = store.begin(identity), b = store.begin(identity);
  assert.equal(store.commit(b.token, turn), true); assert.equal(store.commit(a.token, { ...turn, strategy: { goal: 'stale' } }), false);
  const pendingRound = store.begin(identity);
  assert.equal(store.recordRound(identity.roomSessionId, round(1)), 1);
  assert.equal(store.commit(pendingRound.token, turn), false);
  const pendingPlayer = store.begin(identity); assert.equal(store.clearPlayer(identity.roomSessionId, identity.playerId), true);
  store.begin(identity); assert.equal(store.commit(pendingPlayer.token, turn), false);
  const pendingRoom = store.begin(identity); assert.equal(store.clearRoom(identity.roomSessionId), true);
  assert.equal(store.commit(pendingRoom.token, turn), false, 'A late result must not recreate cleared memory');
  assert.equal(store.snapshot(identity.roomSessionId, identity.playerId), null);
  store.begin(identity); assert.equal(store.commit(pendingRoom.token, turn), false);
  assert.equal(store.commit({}, turn), false);
});

test('invalid or removed-operation AI results leave private state untouched', () => {
  const store = new AgentMemoryStore();
  for (const result of [null, { operation: 'decide', stay: true }, { operation: 'price', name: '价格', price: 88 }, { operation: 'imagine', name: '' }, { operation: 'imagine', name: '字'.repeat(41) }, { operation: 'chat', text: '旧聊天' }, { operation: 'chat', silence: true }]) {
    const pending = store.begin(identity);
    assert.equal(store.commit(pending.token, result), false);
    const snapshot = store.snapshot(identity.roomSessionId, identity.playerId);
    assert.equal(snapshot.revision, 0); assert.deepEqual(snapshot.recentTurns, []); assert.deepEqual(snapshot.strategy, {});
  }
  const malformed = store.begin(identity);
  assert.throws(() => store.commit(malformed.token, { ...turn, strategy: { risk: 'invalid' } }), /策略/);
  assert.equal(store.snapshot(identity.roomSessionId, identity.playerId).recentTurns.length, 0);
  assert.equal(store.commit(malformed.token, turn), false, 'A rejected result cannot reuse its consumed token');
});

test('imagination history and public round summaries stay bounded, deduplicated and ordered', () => {
  const store = new AgentMemoryStore({ maxRecentTurns: 999, maxRoundSummaries: 999 });
  for (let i = 1; i <= 30; i++) {
    const pending = store.begin({ ...identity, round: i });
    assert.equal(store.commit(pending.token, { operation: 'imagine', name: '茶香构想' + i, strategy: { budgetPlan: '第' + i + '轮预算' } }), true);
    assert.equal(store.recordRound(identity.roomSessionId, round(i)), 1);
    assert.equal(store.recordRound(identity.roomSessionId, round(i)), 0);
  }
  const saved = store.snapshot(identity.roomSessionId, identity.playerId);
  assert.equal(saved.recentTurns.length, 12); assert.equal(saved.recentTurns[0].name, '茶香构想19');
  assert.ok(saved.recentTurns.every(item => item.operation === 'imagine'));
  assert.equal(saved.roundSummaries.length, 10); assert.equal(saved.roundSummaries[0].round, 21);
  assert.ok(saved.summary.length <= 1800); assert.match(saved.summary, /第30轮/);
  assert.equal(saved.strategy.budgetPlan, '第30轮预算');
});

test('request memory contains allowed strategy and public summaries without raw reasoning or arbitrary fields', () => {
  const secret = 'PRIVATE_RAW_REASONING';
  const result = round(1); result.secret = secret; result.players[0].private = secret; result.contributions[0].token = secret;
  const context = privateMemoryContext({ persona: '自己的风格', strategy: { goal: '目标', budgetPlan: '保留一半', risk: 'cautious', notes: ['笔记'], rawReasoning: secret }, reasoning_content: secret, recentTurns: [{ ...turn, reasoning_content: secret }], roundSummaries: [result] });
  assert.ok(!JSON.stringify(context).includes(secret));
  assert.deepEqual(context.strategy, { goal: '目标', budgetPlan: '保留一半', risk: 'cautious', notes: ['笔记'] });
  assert.equal(publicRoundSummary({ round: -1 }), null);
  assert.throws(() => normalizeStrategy({ notes: Array(5).fill('note') }), /策略/);
  assert.throws(() => normalizeStrategy({ goal: '字'.repeat(201) }), /策略/);
  assert.throws(() => normalizeStrategy({ budgetPlan: 123 }), /策略/);
  assert.equal(normalizeStrategy({ risk: 'invalid' }, { strict: false }), undefined);
});

test('legacy chat fields and utterances are never saved or included in imagination memory', () => {
  const removed = 'REMOVED_CHAT_DATA';
  const store = new AgentMemoryStore();
  const pending = store.begin({ ...identity, publicChat: [{ text: removed }], chat: { recent: [removed] }, cursor: 99 });
  assert.deepEqual(Object.keys(pending).sort(), ['memory', 'token']);
  assert.ok(!JSON.stringify(pending.memory).includes(removed));
  assert.equal(store.commit(pending.token, {
    ...turn, utterance: removed, text: removed, silence: true, chat: removed, cursor: 99,
    strategy: { goal: '寻找机会', socialStance: removed },
  }), true);
  const snapshot = store.snapshot(identity.roomSessionId, identity.playerId);
  assert.ok(!JSON.stringify(snapshot).includes(removed));
  assert.deepEqual(snapshot.strategy, { goal: '寻找机会' });
  assert.deepEqual(snapshot.recentTurns, [{ operation: 'imagine', round: 1, name: turn.name }]);
  const context = privateMemoryContext({
    ...snapshot, cursor: 99, publicChat: [removed], chat: { recent: [removed] }, utterance: removed,
    strategy: { goal: '寻找机会', socialStance: removed },
    recentTurns: [{ operation: 'chat', text: removed }, { ...turn, utterance: removed, text: removed }, { operation: 'chat', silence: true, name: removed }],
  });
  assert.ok(!JSON.stringify(context).includes(removed));
  assert.deepEqual(context.recentTurns, [{ operation: 'imagine', round: undefined, name: turn.name }]);
  assert.equal(context.cursor, undefined); assert.equal(context.chat, undefined);
  assert.deepEqual(normalizeStrategy({ socialStance: removed }), {});
});

test('legacy chat entries do not consume the twelve retained imagination slots', () => {
  const recentTurns = Array.from({ length: 15 }, (_, index) => [
    { operation: 'imagine', round: index + 1, name: '材料' + (index + 1) },
    { operation: 'chat', round: index + 1, text: '旧消息' },
  ]).flat();
  const context = privateMemoryContext({ recentTurns });
  assert.equal(context.recentTurns.length, 12);
  assert.deepEqual(context.recentTurns.map(item => item.name), Array.from({ length: 12 }, (_, index) => '材料' + (index + 4)));
});

test('successful quotes retain unselected candidates across rounds and selection does not add a second price entry', () => {
  const store = new AgentMemoryStore();
  for (const result of [quote('选中的微光', 100, 'quote-a'), quote('暂时留下的月露', 150, 'quote-b')]) {
    assert.equal(store.commit(store.begin(identity).token, result), true);
  }
  const chosen = { ...quote('选中的微光', 100, 'quote-a'), action: 'select', strategy: { goal: '留月露下轮再用', budgetPlan: '本轮投入100金币' } };
  assert.equal(store.commit(store.begin(identity).token, chosen), true);
  assert.equal(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices.length, 2);
  const settlement = round(1);
  settlement.contributions = [{ ownerId: identity.playerId, name: chosen.name, price: chosen.price, tier: chosen.tier }];
  store.recordRound(identity.roomSessionId, settlement);
  const next = store.begin({ ...identity, round: 2 });
  assert.deepEqual(next.memory.knownPrices, [
    { name: '选中的微光', price: 100, tier: 'blue', round: 1, source: 'own-quote' },
    { name: '暂时留下的月露', price: 150, tier: 'blue', round: 1, source: 'own-quote' },
    { name: '选中的微光', price: 100, tier: 'blue', round: 1, source: 'public-contribution' },
  ]);
  assert.deepEqual(next.memory.recentTurns.map(item => item.action), ['quote', 'quote', 'select']);
  assert.equal(next.memory.recentTurns.at(-1).quoteId, 'quote-a');
  assert.equal(next.memory.strategy.goal, '留月露下轮再用');
  assert.equal(next.memory.strategy.budgetPlan, '本轮投入100金币');
  next.memory.knownPrices[1].price = 999;
  assert.equal(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices[1].price, 150, 'Caller edits must not change private memory');
});

test('each witch learns public contributions and every intermediate product while retaining only her own private quotes', () => {
  const store = new AgentMemoryStore();
  const other = { ...identity, playerId: 'witch-b' };
  store.commit(store.begin(identity).token, quote('甲的未选候选', 100));
  store.commit(store.begin(other).token, quote('乙的未选候选', 150));
  store.begin({ ...identity, roomSessionId: 'other-session' });
  const settlement = { ...round(1), products: [
    { name: '第一束合成微光', price: 180, tier: 'blue', reasoning_content: 'DROP_PRODUCT_REASONING' },
    { name: '继续反应后的星霜', price: 260, tier: 'purple', private: 'DROP_PRODUCT_REASONING' },
  ] };
  assert.equal(store.recordRound(identity.roomSessionId, settlement), 2);
  assert.equal(store.recordRound(identity.roomSessionId, settlement), 0);
  for (const [player, own, hidden] of [[identity.playerId, '甲的未选候选', '乙的未选候选'], [other.playerId, '乙的未选候选', '甲的未选候选']]) {
    const saved = store.snapshot(identity.roomSessionId, player);
    assert.ok(saved.knownPrices.some(item => item.name === own && item.source === 'own-quote'));
    assert.ok(!saved.knownPrices.some(item => item.name === hidden));
    assert.deepEqual(saved.knownPrices.filter(item => item.source === 'public-product').map(item => item.name), ['第一束合成微光', '继续反应后的星霜']);
    assert.ok(saved.knownPrices.some(item => item.name === '微光' && item.source === 'public-contribution'));
    assert.deepEqual(saved.roundSummaries[0].products, [
      { name: '第一束合成微光', price: 180, tier: 'blue' },
      { name: '继续反应后的星霜', price: 260, tier: 'purple' },
    ]);
    assert.ok(!JSON.stringify(saved).includes('DROP_PRODUCT_REASONING'));
  }
  assert.deepEqual(store.snapshot('other-session', identity.playerId).knownPrices, []);
});

test('the price ledger deduplicates normalized names per round and source and preserves later price changes', () => {
  const store = new AgentMemoryStore();
  for (const result of [quote(' ＡＢＣ  茶露 ', 100), quote('ABC 茶露', 120, 'quote-b')]) {
    assert.equal(store.commit(store.begin(identity).token, result), true);
  }
  store.recordRound(identity.roomSessionId, { ...round(1), contributions: [{ name: 'ABC 茶露', price: 120, tier: 'blue' }, { name: 'ABC 茶露', price: 120, tier: 'blue' }], products: [{ name: 'ABC 茶露', price: 120, tier: 'blue' }] });
  assert.equal(store.commit(store.begin({ ...identity, round: 2 }).token, quote('ABC 茶露', 180)), true);
  assert.deepEqual(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices, [
    { name: 'ABC 茶露', price: 120, tier: 'blue', round: 1, source: 'own-quote' },
    { name: 'ABC 茶露', price: 120, tier: 'blue', round: 1, source: 'public-contribution' },
    { name: 'ABC 茶露', price: 120, tier: 'blue', round: 1, source: 'public-product' },
    { name: 'ABC 茶露', price: 180, tier: 'blue', round: 2, source: 'own-quote' },
  ]);
});

test('price memory is bounded independently of recent turns and retains the newest rounds', () => {
  const store = new AgentMemoryStore({ maxKnownPrices: 999 });
  for (let i = 1; i <= 270; i++) {
    assert.equal(store.commit(store.begin({ ...identity, round: i }).token, quote('候选' + i, i)), true);
  }
  const saved = store.snapshot(identity.roomSessionId, identity.playerId);
  assert.equal(saved.knownPrices.length, 256);
  assert.equal(saved.knownPrices[0].round, 15);
  assert.equal(saved.knownPrices.at(-1).round, 270);
  assert.equal(saved.recentTurns.length, 12);
  assert.ok(saved.knownPrices.some(item => item.round === 15), 'Older quotes survive the recent-turn limit');
  store.recordRound(identity.roomSessionId, round(1));
  assert.deepEqual(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices, saved.knownPrices, 'An older public result cannot evict newer price observations');
  const small = new AgentMemoryStore({ maxKnownPrices: 2 });
  for (const name of ['第一份', '第二份', '第三份']) small.commit(small.begin(identity).token, quote(name));
  assert.deepEqual(small.snapshot(identity.roomSessionId, identity.playerId).knownPrices.map(item => item.name), ['第二份', '第三份']);
  assert.equal(privateMemoryContext({ knownPrices: Array.from({ length: 300 }, (_, index) => ({ name: '材料' + index, price: index, tier: 'blue', round: index + 1, source: 'own-quote' })) }).knownPrices.length, 256);
});

test('price memory and action history discard unsupported fields and malformed observations', () => {
  const secret = 'DROP_RAW_REASONING_AND_CHAT';
  const valid = { name: '可信材料', price: 99, tier: 'blue', round: 1, source: 'own-quote' };
  const context = privateMemoryContext({
    knownPrices: [
      { ...valid, reasoning_content: secret, chat: secret, arbitrary: secret }, null, 'invalid',
      { ...valid, name: '' }, { ...valid, name: '字'.repeat(81) }, { ...valid, price: -1 }, { ...valid, price: 1000000001 },
      { ...valid, price: 1.1 }, { ...valid, price: '99' }, { ...valid, round: 0 }, { ...valid, source: secret },
      { ...valid, name: '无效品质材料', tier: secret },
    ],
    recentTurns: [{ ...quote(), round: 1, reasoning_content: secret, chat: secret }, { ...quote(), action: secret }],
    roundSummaries: [{ ...round(1), products: [null, { name: '公开产物', price: 199, tier: 'blue', reasoning_content: secret, chat: secret }] }],
  });
  assert.ok(!JSON.stringify(context).includes(secret));
  assert.deepEqual(context.knownPrices, [valid, { ...valid, name: '无效品质材料', tier: '' }]);
  assert.deepEqual(Object.keys(context.recentTurns[0]).sort(), ['action', 'name', 'operation', 'price', 'quoteId', 'round', 'tier']);
  assert.equal(context.recentTurns.length, 1);
  assert.deepEqual(context.roundSummaries[0].products, [{ name: '公开产物', price: 199, tier: 'blue' }]);
});

test('quote/select actions accept eighty-character names but malformed actions cannot alter prices or strategy', () => {
  const store = new AgentMemoryStore();
  const long = quote('字'.repeat(80));
  assert.equal(store.commit(store.begin(identity).token, long), true);
  assert.equal(store.commit(store.begin(identity).token, { ...long, action: 'select' }), true);
  const before = store.snapshot(identity.roomSessionId, identity.playerId);
  assert.equal(before.knownPrices[0].name.length, 80);
  assert.equal(before.recentTurns.at(-1).name.length, 80);
  for (const invalid of [
    { ...quote(), action: 'buy' }, { ...quote(), quoteId: '' }, { ...quote(), quoteId: 'q'.repeat(101) },
    { ...quote(), name: '字'.repeat(81) }, { ...quote(), name: '\u0000broken' },
    { ...quote(), price: undefined }, { ...quote(), price: -1 }, { ...quote(), price: 1000000001 },
    { ...quote(), price: '100' }, { ...quote(), action: 'select', price: Number.NaN },
  ]) {
    const pending = store.begin(identity);
    assert.equal(store.commit(pending.token, { ...invalid, strategy: { goal: '必须丢弃' } }), false);
    assert.equal(store.commit(pending.token, quote()), false);
    assert.deepEqual(store.snapshot(identity.roomSessionId, identity.playerId), before);
  }
});

test('late quotes cannot contaminate the ledger after a newer turn, settlement, player removal or room cleanup', () => {
  const store = new AgentMemoryStore();
  const stale = store.begin(identity), current = store.begin(identity);
  assert.equal(store.commit(current.token, quote('新报价', 100)), true);
  assert.equal(store.commit(stale.token, quote('过时报价', 150)), false);
  const beforeRoundEnd = store.begin(identity);
  store.recordRound(identity.roomSessionId, round(1));
  assert.equal(store.commit(beforeRoundEnd.token, quote('结算后迟到', 150)), false);
  assert.deepEqual(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices.map(item => item.name), ['新报价', '微光']);
  const beforePlayerRemoval = store.begin(identity);
  store.clearPlayer(identity.roomSessionId, identity.playerId);
  store.begin(identity);
  assert.equal(store.commit(beforePlayerRemoval.token, quote('旧玩家迟到', 150)), false);
  assert.deepEqual(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices, []);
  const beforeRoomDeletion = store.begin(identity);
  store.clearRoom(identity.roomSessionId);
  assert.equal(store.commit(beforeRoomDeletion.token, quote('旧房间迟到', 150)), false);
  assert.equal(store.snapshot(identity.roomSessionId, identity.playerId), null);
  store.begin(identity);
  assert.deepEqual(store.snapshot(identity.roomSessionId, identity.playerId).knownPrices, []);
});
