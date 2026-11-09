import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { AlchemyProvider, assertPriceInConstraint, materialRefusal, normalizeName, presets, reactionProbability, rules, tierFor, validateMaterialName } from './alchemy.js';
import { synthesisPricePolicy, synthesisRecipeKey } from './synthesis-pricing.js';

const uid = () => randomUUID();
const copyCards = cards => cards.map(card => ({ ...card, tier: tierFor(card.price) }));
const isLocked = card => card.price >= rules.tierMinimums.red;
const materialDetails = card => ({ name: card.name, price: card.price, tier: tierFor(card.price) });

export class GameRoom extends EventEmitter {
  constructor({ id, rounds = 3, provider = new AlchemyProvider(), depositMs = rules.depositMs, reactionMs = rules.reactionMs, holdMs = rules.holdMs, chainHoldMs = Math.min(holdMs, rules.chainHoldMs), random = Math.random, priceRandom = () => (randomBytes(6).readUIntBE(0, 6) + 0.5) / 2 ** 48 } = {}) {
    super();
    if (!rules.allowedRounds.includes(rounds)) throw new Error('比赛轮数只能是 3、5 或 10 轮');
    this.id = id || randomBytes(3).toString('hex').toUpperCase();
    this.roomSessionId = uid();
    this.abortController = new AbortController();
    this.totalRounds = rounds;
    this.provider = provider;
    this.depositMs = Math.max(0, Number(depositMs) || 0);
    this.reactionMs = Math.max(0, Number(reactionMs) || 0);
    this.holdMs = Math.max(0, Number(holdMs) || 0);
    this.chainHoldMs = Math.max(0, Number(chainHoldMs) || 0);
    this.random = random;
    this.priceRandom = priceRandom;
    this.seed = randomBytes(32).toString('hex');
    this.players = [];
    this.departedPlayers = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.round = 0;
    this.lap = 0;
    this.turnOrder = [];
    this.turnPlayerId = null;
    this.deadline = null;
    this.resolvingStartedAt = null;
    this.presentation = null;
    this.pot = [];
    this.contributions = [];
    this.log = [];
    this.roundResult = null;
    this.roundEvents = [];
    this.completedRounds = [];
    this.matchWinnerId = null;
    this.matchWinnerIds = [];
    this.finishReason = null;
    this.priceCache = new Map();
    this.priceFlights = new Map();
    this.synthesisCache = new Map();
    this.busy = false;
    this.processingError = null;
    this.pendingCommit = null;
    this.resolutionBatch = null;
    this.disposed = false;
    this.timer = null;
    this.provider.recordEvent?.(this.aiTrace(), { type: 'room_created', status: 'created', totalRounds: rounds });
  }

  // Diagnostics and private model context never enter a player's view.
  aiTrace(playerOrId = null) {
    const player = typeof playerOrId === 'string' ? this._player(playerOrId) : playerOrId;
    return {
      roomId: this.id, roomSessionId: this.roomSessionId, round: this.round, lap: this.lap, signal: this.abortController.signal,
      player: player ? { id: player.id, name: player.name, bot: player.bot, botIndex: player.bot ? this.players.filter(p => p.bot).findIndex(p => p.id === player.id) + 1 : null } : null,
    };
  }
  withAITrace(playerOrId, operation) {
    return this.provider.withTrace ? this.provider.withTrace(this.aiTrace(playerOrId), operation) : operation();
  }
  _cachedAI(operation, request, value, source, durationMs = 0) {
    this.provider.recordEvent?.(null, { type: 'cache_hit', operation, status: 'cache', source, request, durationMs, response: { content: JSON.stringify(value), reasoningContent: null }, result: value });
  }
  _log(text) { this.log.push({ id: uid(), text }); if (this.log.length > 60) this.log.shift(); }
  _change() { if (!this.disposed) this.emit('change'); }
  _active() { return this.players.filter(player => player.status === 'active' && !player.departurePending); }
  _player(id) {
    const player = this.players.find(item => item.id === id);
    if (!player) throw new Error('你不在这个房间里');
    return player;
  }
  _randomIndex(length) { return Math.min(length - 1, Math.max(0, Math.floor((Number(this.random()) || 0) * length))); }

  addPlayer(rawName, { bot = false } = {}) {
    if (this.phase !== 'lobby') throw new Error('比赛已经开始，暂时不能加入');
    if (bot && !this.provider.ready) throw new Error('服务器尚未配置 DeepSeek 密钥，暂时无法添加 AI 女巫，请设置 DEEPSEEK_API_KEY 后重启服务');
    if (this.players.length >= rules.maxPlayers) throw new Error('房间已满');
    const name = normalizeName(rawName).slice(0, 16);
    const player = { id: uid(), name, bot, connected: true, departurePending: false, departureReason: null, status: 'active', coins: rules.startingCoins, score: rules.startingCoins, quotes: [], preparedQuoteId: null, quoteBusy: false, quoteRequestId: null, roundBefore: rules.startingCoins, roundCost: 0, roundWinnings: 0 };
    this.players.push(player);
    if (!bot) this.hostId ||= player.id;
    this._log(name + ' 来到了下午茶聚会');
    this._change();
    return player;
  }
  setConnected(id, connected) {
    const player = this._player(id);
    if (connected && player.departurePending) throw new Error('该玩家已确认离场');
    player.connected = Boolean(connected);
    if (connected && !this.hostId) this._ensureHost();
    this._change();
  }
  transferHost(id) {
    const candidate = this._player(id);
    if (candidate.bot || !candidate.connected || candidate.departurePending) throw new Error('房主需要是在线真人玩家');
    this.hostId = candidate.id;
    this._change();
    return this.hostId;
  }
  _ensureHost() {
    const current = this.players.find(player => player.id === this.hostId);
    if (current && !current.departurePending && !current.bot) return;
    this.hostId = this.players.find(player => !player.bot && player.connected && !player.departurePending)?.id ?? null;
  }
  _stopPreparing(player) {
    player.quotes = [];
    player.preparedQuoteId = null;
    player.quoteBusy = false;
    player.quoteRequestId = null;
  }
  markDeparting(id, { reason = 'disconnect' } = {}) {
    const player = this.players.find(item => item.id === id);
    if (!player || player.departurePending || this.disposed) return false;
    player.connected = false;
    player.departurePending = true;
    player.departureReason = reason;
    this._ensureHost();
    if (['lobby', 'roundEnd', 'finished'].includes(this.phase)) this.removeDepartedPlayers();
    else if (this.phase === 'preparing') {
      this._stopPreparing(player);
      this.turnOrder = this.turnOrder.filter(playerId => playerId !== id);
      const active = this._active();
      if (active.length <= 1) this._finishWithoutContributions();
      else if (active.every(item => item.preparedQuoteId)) this._startResolution();
      else this._change();
    } else {
      // Committed contributions are paid for; departure cannot undo them or their prize eligibility.
      this._change();
    }
    return true;
  }
  removeDepartedPlayers({ emit = true } = {}) {
    if (!['lobby', 'roundEnd', 'finished'].includes(this.phase)) return [];
    const removed = this.players.filter(player => player.departurePending);
    for (const player of removed) {
      this._stopPreparing(player);
      if (this.round > 0) this.departedPlayers.push({ id: player.id, name: player.name, bot: player.bot, connected: false, departurePending: true, status: 'departed', score: player.score, coins: player.coins });
    }
    this.players = this.players.filter(player => !player.departurePending);
    this.turnOrder = this.turnOrder.filter(id => this.players.some(player => player.id === id));
    this._ensureHost();
    // Leaving a completed match changes attendance, never its recorded winners.
    if (this.phase === 'roundEnd') this._updateMatchOutcome();
    if (emit) this._change();
    return removed.map(player => player.id);
  }
  removePlayer(id) {
    if (this.phase !== 'lobby') throw new Error('比赛中不能移除玩家，请离开房间');
    const player = this._player(id);
    this.players = this.players.filter(item => item.id !== id);
    this._ensureHost();
    this._log(player.name + ' 离开了下午茶聚会');
    this._change();
  }

  async action(playerId, type, payload = {}) {
    if (this.disposed) throw new Error('房间已经关闭');
    const player = this._player(playerId);
    if (player.departurePending) throw new Error('该玩家已确认离场');
    switch (type) {
      case 'start':
        if (playerId !== this.hostId) throw new Error('只有房主可以开始比赛');
        if (this.phase !== 'lobby') throw new Error('比赛已经开始');
        if (!this.provider.ready) throw new Error('服务器尚未配置 DeepSeek 密钥，暂时无法开始比赛，请设置 DEEPSEEK_API_KEY 后重启服务');
        if (this._active().length < 2) throw new Error('至少需要两位女巫才能开始');
        this._beginRound();
        break;
      case 'nextRound':
        if (playerId !== this.hostId) throw new Error('只有房主可以开始下一轮');
        if (this.phase !== 'roundEnd') throw new Error('当前还不能开始下一轮');
        if (this._active().length < 2) throw new Error('至少需要两位仍在场的女巫才能开始下一轮');
        this._beginRound();
        break;
      case 'quote':
        this._requirePreparation(player);
        await this.withAITrace(player, () => this._quote(player, payload.name));
        break;
      case 'commit':
        this._requirePreparation(player);
        this._prepare(player, payload.quoteId);
        break;
      case 'unready':
        this._requirePreparation(player);
        if (player.quoteBusy) throw new Error('材料召唤尚未完成，请稍候');
        player.preparedQuoteId = null;
        this._change();
        break;
      case 'retryCommit':
        if (this.phase !== 'resolving' || !this.processingError || this.busy) throw new Error('当前没有需要重试的炼金');
        if (player.id !== this.hostId && player.id !== this.turnPlayerId) throw new Error('只有房主或当前投料的女巫可以重试');
        void this._resolveCurrent();
        break;
      default: throw new Error('未知游戏操作');
    }
    return this.view(playerId);
  }
  _requirePreparation(player) {
    if (this.phase !== 'preparing' || player.status !== 'active') throw new Error('现在不是你的备料时间');
  }
  _beginRound() {
    clearTimeout(this.timer);
    this.round += 1;
    this.lap = 1;
    this.phase = 'preparing';
    this.turnPlayerId = null;
    this.deadline = null;
    this.resolvingStartedAt = null;
    this.presentation = null;
    this.pot = [];
    this.contributions = [];
    this.roundResult = null;
    this.roundEvents = [];
    this.processingError = null;
    this.pendingCommit = null;
    this.resolutionBatch = null;
    this.busy = false;
    this.priceCache = new Map(presets.map(item => [normalizeName(item.name), { name: normalizeName(item.name), price: item.price, source: 'preset' }]));
    this.priceFlights = new Map();
    this.synthesisCache = new Map();
    for (const player of this.players) {
      player.roundBefore = player.coins;
      player.roundCost = 0;
      player.roundWinnings = 0;
      player.score = player.coins;
      this._stopPreparing(player);
    }
    this.turnOrder = this._active().map(player => player.id);
    // Each round gets an independent Fisher–Yates permutation.
    for (let index = this.turnOrder.length - 1; index > 0; index--) {
      const other = this._randomIndex(index + 1);
      [this.turnOrder[index], this.turnOrder[other]] = [this.turnOrder[other], this.turnOrder[index]];
    }
    this._log('第 ' + this.round + ' 轮开始，女巫们各自构想一份材料');
    this._change();
  }
  _prepare(player, quoteId) {
    if (player.quoteBusy) throw new Error('材料召唤尚未完成，请稍候');
    if (player.preparedQuoteId) throw new Error('你已经准备完成，请先取消准备再选择材料');
    if (!player.quotes.some(quote => quote.id === quoteId)) throw new Error('请选择本轮已召唤的备选材料');
    player.preparedQuoteId = quoteId;
    if (this._active().every(item => item.preparedQuoteId)) this._startResolution();
    else this._change();
  }
  _startResolution() {
    if (this.disposed || this.phase !== 'preparing') return;
    const active = this._active();
    if (active.length <= 1) return this._finishWithoutContributions();
    if (!active.every(player => player.preparedQuoteId)) return;
    const contributions = this.turnOrder.map((ownerId, order) => {
      const player = this._player(ownerId);
      const quote = player.quotes.find(item => item.id === player.preparedQuoteId);
      if (!quote) throw new Error('预备材料已失效，请重新准备');
      return { id: uid(), ownerId, ownerName: player.name, ...materialDetails(quote), order };
    });
    // One synchronous transition publishes every material and charges each owner exactly once.
    for (const contribution of contributions) {
      const player = this._player(contribution.ownerId);
      player.roundCost = contribution.price;
      player.coins -= contribution.price;
      player.score = player.coins;
    }
    this.contributions = contributions;
    this.pot = [];
    this.roundEvents = contributions.map(card => ({ id: uid(), kind: 'deposit', playerId: card.ownerId, playerName: card.ownerName, material: materialDetails(card), order: card.order }));
    this.resolutionBatch = { round: this.round, order: contributions.map(card => card.ownerId), plans: [], pot: [], prices: new Map(this.priceCache), synthesis: new Map(this.synthesisCache), settled: false };
    this.phase = 'resolving';
    this.resolvingStartedAt = Date.now();
    this.deadline = null;
    void this._resolveCurrent();
  }
  async _resolveCurrent() {
    if (this.disposed || this.phase !== 'resolving' || this.busy) return;
    const batch = this.resolutionBatch;
    if (!batch || batch.settled) return;
    this.busy = true;
    this.processingError = null;
    this._change();
    try {
      while (batch.plans.length < batch.order.length) {
        this._requireBatch(batch);
        const contribution = this.contributions[batch.plans.length];
        this.turnPlayerId = contribution.ownerId;
        if (!this.pendingCommit) this.pendingCommit = { round: this.round, contribution, prices: new Map(batch.prices), synthesis: new Map(batch.synthesis), rolls: [], pricingPolicies: [], productIds: [], frameIds: [], pot: copyCards(batch.pot) };
        this._change();
        // This is shared alchemy, regardless of which human or AI supplied the material.
        const plan = await this.withAITrace(null, () => this._commit(this.pendingCommit));
        this._requireBatch(batch);
        batch.plans.push(plan);
        batch.pot = copyCards(plan.pot);
        batch.prices = new Map(plan.prices);
        batch.synthesis = new Map(plan.synthesis);
        this.pendingCommit = null;
        this._change();
      }
      this._beginPerformance(batch);
    } catch (error) {
      if (!this.disposed && this.resolutionBatch === batch && this.round === batch.round) this.processingError = error?.message || '炼金暂时未完成，请重试';
    } finally {
      if (this.resolutionBatch === batch && this.phase === 'resolving') {
        this.busy = false;
        this._change();
      }
    }
  }
  _requireBatch(batch) {
    if (this.disposed || this.resolutionBatch !== batch || this.round !== batch.round || this.phase !== 'resolving') throw new Error('本轮炼金已过期');
  }
  _beginPerformance(batch) {
    if (this.disposed || this.resolutionBatch !== batch || this.phase !== 'resolving' || batch.plans.length !== batch.order.length) return;
    batch.frames = batch.plans.flatMap(plan => plan.frames);
    batch.frameIndex = 0;
    batch.performanceComplete = false;
    this.phase = 'performing';
    this.pot = [];
    this.busy = false;
    this._playFrame(batch);
  }
  _playFrame(batch) {
    if (this.disposed || this.resolutionBatch !== batch || this.phase !== 'performing') return;
    const frame = batch.frames[batch.frameIndex];
    if (!frame) {
      batch.performanceComplete = true;
      batch.lastPresentation = this.presentation ? structuredClone(this.presentation) : null;
      this.presentation = null;
      this._finishRound(batch);
      return;
    }
    const startedAt = Date.now();
    this.presentation = { ...frame, index: batch.frameIndex, total: batch.frames.length, startedAt };
    this.pot = copyCards(frame.potBefore);
    this.turnPlayerId = frame.playerId;
    this.deadline = startedAt + frame.durationMs;
    this.timer = setTimeout(() => {
      if (this.disposed || this.resolutionBatch !== batch || this.phase !== 'performing' || this.presentation?.id !== frame.id) return;
      this.pot = copyCards(frame.potAfter);
      batch.frameIndex += 1;
      this._playFrame(batch);
    }, frame.durationMs);
    this.timer.unref?.();
    this._change();
  }
  _context(prices = this.priceCache, synthesis = this.synthesisCache) {
    return { prices: [...prices.values()].map(({ name, price }) => ({ name, price })), history: [...synthesis.values()].map(item => ({ ...item })) };
  }
  async _price(name, prices = this.priceCache, synthesis = this.synthesisCache, sourceInputs = null, priceConstraint = null) {
    const normalized = validateMaterialName(name);
    if (prices.has(normalized)) {
      const value = prices.get(normalized);
      assertPriceInConstraint(value.price, priceConstraint);
      this._cachedAI('price', { material: normalized }, value, value.source === 'preset' ? 'preset' : 'cache');
      return { ...value, source: 'cache' };
    }
    const flights = prices === this.priceCache ? this.priceFlights : null;
    const round = this.round;
    if (flights?.has(normalized)) {
      const started = performance.now();
      const value = await flights.get(normalized);
      assertPriceInConstraint(value.price, priceConstraint);
      this._cachedAI('price', { material: normalized }, value, 'inflight', Math.round(performance.now() - started));
      return { ...value };
    }
    const request = Promise.resolve().then(async () => {
      const context = this._context(prices, synthesis);
      if (sourceInputs) context.synthesisInputs = sourceInputs.map(({ name: material, price }) => ({ name: material, price }));
      if (priceConstraint) context.priceConstraint = priceConstraint;
      const result = await this.provider.price(normalized, context);
      if (result?.refused === true) throw materialRefusal();
      if (!Number.isSafeInteger(result?.price) || result.price < 0 || result.price > rules.maxMaterialPrice) throw new Error('材料金币价值无效');
      assertPriceInConstraint(result.price, priceConstraint);
      if (this.disposed || this.round !== round || (flights && this.priceCache !== prices)) throw new Error('本次材料召唤已过期，请重新构想');
      const value = { name: normalized, price: result.price, source: result.source || this.provider.mode };
      prices.set(normalized, value);
      return value;
    });
    flights?.set(normalized, request);
    try { return await request; }
    finally { if (flights?.get(normalized) === request) flights.delete(normalized); }
  }
  async _quote(player, rawName) {
    if (player.quoteBusy) throw new Error('材料召唤正在处理中，请稍候');
    if (player.preparedQuoteId) throw new Error('你已经准备完成，请先取消准备再构想材料');
    if (player.quotes.length >= rules.maxQuotes) throw new Error('本轮已经用完三次材料构想，请选择已有备选材料');
    let name;
    try { name = validateMaterialName(rawName); }
    catch (error) {
      this.provider.recordEvent?.(null, { type: 'rejected', operation: 'price', status: 'local_rejection', source: 'local', request: { material: rawName }, durationMs: 0, error: error.message });
      throw error;
    }
    const round = this.round, requestId = uid();
    player.quoteBusy = true;
    player.quoteRequestId = requestId;
    this._change();
    try {
      const value = await this._price(name);
      if (this.disposed || this.round !== round || this.phase !== 'preparing' || player.quoteRequestId !== requestId || player.status !== 'active' || player.departurePending) throw new Error('本次材料召唤已过期，请重新构想');
      player.quotes.push({ id: uid(), ...value, tier: tierFor(value.price) });
    } finally {
      if (player.quoteRequestId === requestId) { player.quoteBusy = false; player.quoteRequestId = null; }
      this._change();
    }
  }
  _sort(pot) { return pot.sort((a, b) => a.order - b.order); }
  async _commit(pending) {
    const { prices, synthesis, contribution } = pending;
    let rollIndex = 0;
    const roll = () => {
      if (rollIndex === pending.rolls.length) pending.rolls.push(this.random());
      return pending.rolls[rollIndex++];
    };
    let incoming = { ...contribution };
    let pot = this._sort([...copyCards(pending.pot), incoming]);
    const events = [];
    const frames = [];
    const addFrame = frame => {
      const index = frames.length;
      pending.frameIds[index] ||= uid();
      // A further reaction continues this deposit's chain; only its final frame
      // keeps the longer reading hold before the next witch or settlement.
      const previous = frames.at(-1);
      if (frame.kind === 'reaction' && previous) {
        previous.holdMs = this.chainHoldMs;
        previous.durationMs = previous.animationMs + previous.holdMs;
      }
      frames.push({ id: pending.frameIds[index], playerId: contribution.ownerId, playerName: contribution.ownerName, ...frame, holdMs: this.holdMs, durationMs: frame.animationMs + this.holdMs });
    };
    addFrame({ kind: 'deposit', material: { ...incoming }, potBefore: copyCards(pending.pot), potAfter: copyCards(pot), animationMs: this.depositMs });
    // Each reaction consumes one existing entry, so circular recipes also terminate.
    while (pot.length > 1 && !isLocked(incoming)) {
      let partner = null;
      const candidates = pot.filter(item => item.id !== incoming.id && !isLocked(item)).sort((a, b) => a.price - b.price || a.order - b.order);
      for (const candidate of candidates) {
        if (roll() < reactionProbability(incoming.name, candidate.name, this.seed)) { partner = candidate; break; }
      }
      if (!partner) break;
      const reactionIndex = events.length;
      // A retry restarts the plan, but each reaction keeps its original lottery.
      let policy = pending.pricingPolicies[reactionIndex];
      if (!policy) {
        policy = synthesisPricePolicy([incoming, partner], this.priceRandom());
        pending.pricingPolicies[reactionIndex] = policy;
        this.provider.recordEvent?.(null, { type: 'synthesis_price_draw', operation: 'synthesize', status: 'selected', reactionIndex, request: policy });
      }
      const { inputs, priceConstraint } = policy;
      const names = inputs.map(item => item.name).sort();
      const key = synthesisRecipeKey(inputs, priceConstraint);
      let recipe = synthesis.get(key);
      if (recipe && prices.has(recipe.name)) {
        const known = prices.get(recipe.name).price;
        if (known < priceConstraint.minPrice || known > priceConstraint.maxPrice) { synthesis.delete(key); recipe = null; }
      }
      if (recipe) this._cachedAI('synthesize', { ingredients: names }, recipe, 'cache');
      if (!recipe) {
        const product = await this.provider.synthesize(inputs[0], inputs[1], { ...this._context(prices, synthesis), priceConstraint });
        if (this.disposed || this.pendingCommit !== pending || this.round !== pending.round) throw new Error('本轮炼金已过期');
        if (product?.refused === true) throw materialRefusal();
        const name = validateMaterialName(product.name);
        if (prices.has(name)) assertPriceInConstraint(prices.get(name).price, priceConstraint);
        recipe = { ingredients: names, name, priceConstraint: { ...priceConstraint } };
        synthesis.set(key, recipe);
      }
      const ingredients = copyCards([incoming, partner]);
      const productPrice = await this._price(recipe.name, prices, synthesis, inputs, priceConstraint);
      const consumedIds = [incoming.id, partner.id];
      const order = Math.min(incoming.order, partner.order);
      const potBefore = copyCards(pot);
      pending.productIds[reactionIndex] ||= uid();
      incoming = { id: pending.productIds[reactionIndex], name: productPrice.name, price: productPrice.price, tier: tierFor(productPrice.price), ownerId: null, order };
      pot = this._sort([...pot.filter(item => !consumedIds.includes(item.id)), incoming]);
      events.push({ id: uid(), kind: 'reaction', ingredients, product: materialDetails(incoming), order });
      addFrame({ kind: 'reaction', ingredients, product: { ...incoming }, potBefore, potAfter: copyCards(pot), animationMs: this.reactionMs });
    }
    if (this.disposed || this.round !== pending.round || this.phase !== 'resolving' || this.pendingCommit !== pending) throw new Error('本轮炼金已过期');
    return { playerId: contribution.ownerId, events, frames, pot, prices: new Map(prices), synthesis: new Map(synthesis) };
  }
  _settlePlayers(winnerId, potValue) {
    return this.players.map(player => {
      const before = player.roundBefore, cost = player.roundCost;
      const winnings = player.id === winnerId ? potValue : 0;
      const rawBalance = before - cost + winnings;
      const balance = Math.max(0, rawBalance);
      player.coins = balance;
      player.score = balance;
      player.roundWinnings = winnings;
      if (rawBalance <= 0) player.status = 'eliminated';
      this._stopPreparing(player);
      return { id: player.id, name: player.name, before, cost, winnings, rawBalance, balance, delta: balance - before, eliminated: player.status === 'eliminated' };
    });
  }
  _finishRound(batch) {
    if (this.disposed || this.resolutionBatch !== batch || batch.settled || this.phase !== 'performing' || !batch.performanceComplete) return;
    batch.settled = true;
    this.pot = copyCards(batch.pot);
    this.priceCache = new Map(batch.prices);
    this.synthesisCache = new Map(batch.synthesis);
    this.roundEvents.push(...batch.plans.flatMap(plan => plan.events));
    const greatest = Math.max(...this.contributions.map(card => card.price));
    const tied = this.contributions.filter(card => card.price === greatest);
    const winner = tied[tied.length === 1 ? 0 : this._randomIndex(tied.length)];
    const potValue = this.pot.reduce((sum, card) => sum + card.price, 0);
    const products = batch.plans.flatMap(plan => plan.events.filter(event => event.kind === 'reaction').map(event => materialDetails(event.product)));
    // Keep the original contributor and the completed material frame available
    // after settlement, departures and refreshes. Each client dismisses this
    // presentation independently; it does not add a server timer or phase.
    const owner = this.players.find(player => player.id === winner.ownerId);
    const winnerCelebration = {
      id: uid(), startedAt: Date.now(), animationMs: rules.winnerAnimationMs,
      winner: { id: winner.ownerId, name: winner.ownerName, bot: Boolean(owner?.bot), avatarIndex: this.turnOrder.indexOf(winner.ownerId) },
      material: { ...materialDetails(winner), ownerId: winner.ownerId },
      backdrop: batch.lastPresentation ? structuredClone(batch.lastPresentation) : null,
    };
    this.roundResult = { round: this.round, winnerId: winner.ownerId, potValue, reason: 'highest-contribution', contributions: copyCards(this.contributions), products, winnerCelebration, players: this._settlePlayers(winner.ownerId, potValue) };
    this.completedRounds.push(structuredClone(this.roundResult));
    this._log(winner.ownerName + ' 以最高原始投料赢得 ' + potValue.toLocaleString('en-US') + ' 金币');
    this._completeRoundBoundary();
  }
  _finishWithoutContributions() {
    if (this.disposed || this.phase !== 'preparing') return;
    const winner = this._active()[0];
    this.roundResult = { round: this.round, winnerId: winner?.id ?? null, potValue: 0, reason: winner ? 'last-standing' : 'no-contenders', contributions: [], products: [], players: this._settlePlayers(null, 0) };
    this._completeRoundBoundary();
  }
  _completeRoundBoundary() {
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    this.turnPlayerId = null;
    this.presentation = null;
    this.pendingCommit = null;
    this.resolutionBatch = null;
    this.busy = false;
    this.processingError = null;
    this.phase = 'roundEnd';
    this.removeDepartedPlayers({ emit: false });
    this._change();
  }
  _updateMatchOutcome() {
    const contenders = this._active();
    let winners = [];
    if (contenders.length <= 1) {
      this.finishReason = contenders.length ? 'last-standing' : 'no-contenders';
      winners = contenders;
    } else if (this.round >= this.totalRounds) {
      this.finishReason = 'round-limit';
      const greatest = Math.max(...contenders.map(player => player.coins));
      winners = contenders.filter(player => player.coins === greatest);
    } else this.finishReason = null;
    if (this.finishReason) this.phase = 'finished';
    this.matchWinnerIds = winners.map(player => player.id);
    this.matchWinnerId = this.matchWinnerIds[0] ?? null;
  }
  view(playerId) {
    const player = this._player(playerId);
    const ordered = [...this.players].sort((a, b) => {
      const first = this.turnOrder.indexOf(a.id), second = this.turnOrder.indexOf(b.id);
      return (first < 0 ? Infinity : first) - (second < 0 ? Infinity : second);
    });
    return {
      id: this.id, phase: this.phase, round: this.round, totalRounds: this.totalRounds,
      finishReason: this.finishReason, matchWinnerId: this.matchWinnerId, matchWinnerIds: [...this.matchWinnerIds],
      hostId: this.hostId, turnPlayerId: this.turnPlayerId, turnOrder: [...this.turnOrder], deadline: this.deadline, serverTime: Date.now(),
      resolvingStartedAt: this.resolvingStartedAt,
      mode: this.provider.mode, aiReady: this.provider.ready ?? false, busy: this.busy, processingError: this.processingError,
      resolutionProgress: this.resolutionBatch ? { completed: this.resolutionBatch.plans.length, total: this.resolutionBatch.order.length } : null,
      players: ordered.map(p => ({ id: p.id, name: p.name, bot: p.bot, connected: p.connected, departurePending: p.departurePending, status: p.status, coins: p.coins, score: p.coins, isHost: p.id === this.hostId, ready: Boolean(p.preparedQuoteId) })),
      departedPlayers: structuredClone(this.departedPlayers),
      me: { id: player.id, coins: player.coins, score: player.coins, quotes: player.quotes.map(quote => ({ ...quote })), quotesRemaining: rules.maxQuotes - player.quotes.length, preparedQuoteId: player.preparedQuoteId, quoteBusy: player.quoteBusy },
      contributions: copyCards(this.contributions),
      presentation: this.phase === 'performing' && this.presentation ? structuredClone(this.presentation) : null,
      pot: this.pot.map(card => ({ ...card, tier: tierFor(card.price), own: card.ownerId === playerId })),
      roundResult: this.roundResult && ['roundEnd', 'finished'].includes(this.phase) ? structuredClone(this.roundResult) : null,
      log: this.log.map(item => ({ ...item })),
      rules: { maxQuotes: rules.maxQuotes, startingCoins: rules.startingCoins, depositMs: this.depositMs, reactionMs: this.reactionMs, holdMs: this.holdMs, chainHoldMs: this.chainHoldMs },
    };
  }
  dispose() {
    this.disposed = true;
    this.abortController.abort();
    clearTimeout(this.timer);
    this.removeAllListeners();
  }
}
