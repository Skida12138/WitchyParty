import { randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const text = (value, limit) => typeof value === 'string' ? [...value.trim()].slice(0, limit).join('') : '';
const integer = value => Number.isSafeInteger(value) ? value : undefined;
const bounded = (value, fallback, maximum) => Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
const risks = new Set(['cautious', 'balanced', 'bold']);
const actions = new Set(['quote', 'select']);
const priceSources = new Set(['own-quote', 'public-contribution', 'public-product']);
const tiers = new Set(['white', 'green', 'blue', 'purple', 'gold', 'red']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const price = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000 ? value : undefined;
const tier = value => tiers.has(value) ? value : '';
const materialName = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';

function knownPrice(value) {
  if (!object(value) || !priceSources.has(value.source) || !Number.isSafeInteger(value.round) || value.round < 1) return null;
  const name = materialName(value.name), amount = price(value.price);
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name) || amount === undefined) return null;
  return { name, price: amount, tier: tier(value.tier), round: value.round, source: value.source };
}

function priceLedger(values, limit = 256) {
  const entries = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const entry = knownPrice(value);
    if (entry) entries.set(JSON.stringify([entry.round, entry.source, entry.name]), entry);
  }
  return [...entries.values()].sort((a, b) => a.round - b.round).slice(-limit);
}

export function normalizeStrategy(value, { strict = true } = {}) {
  if (value === undefined || value === null) return undefined;
  const invalid = () => { if (strict) throw new Error('AI返回了无效的策略记录'); return undefined; };
  if (typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = {};
  for (const key of ['goal', 'budgetPlan']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || [...value[key]].length > 200) return invalid();
    result[key] = text(value[key], 200);
  }
  if (value.risk !== undefined) {
    if (!risks.has(value.risk)) return invalid();
    result.risk = value.risk;
  }
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes) || value.notes.length > 4 || value.notes.some(note => typeof note !== 'string' || [...note].length > 200)) return invalid();
    result.notes = value.notes.map(note => text(note, 200));
  }
  return result;
}

export function publicRoundSummary(result) {
  if (!result || !Number.isSafeInteger(result.round) || result.round < 1) return null;
  return {
    round: result.round, winnerId: typeof result.winnerId === 'string' ? text(result.winnerId, 100) : null,
    potValue: integer(result.potValue),
    contributions: (Array.isArray(result.contributions) ? result.contributions : []).filter(object).slice(0, 8).map(item => ({
      ownerId: text(item.ownerId, 100), name: text(item.name, 80), price: integer(item.price), tier: text(item.tier, 20), order: integer(item.order),
    })),
    products: (Array.isArray(result.products) ? result.products : []).filter(object).slice(0, 256).map(item => ({
      name: text(item.name, 80), price: integer(item.price), tier: tier(item.tier),
    })),
    players: (Array.isArray(result.players) ? result.players : []).filter(object).slice(0, 8).map(player => ({
      id: text(player.id, 100), name: text(player.name, 40), before: integer(player.before), cost: integer(player.cost),
      winnings: integer(player.winnings), rawBalance: integer(player.rawBalance), balance: integer(player.balance),
      delta: integer(player.delta), eliminated: Boolean(player.eliminated),
    })),
  };
}

function recentTurn(value) {
  if (!value || value.operation !== 'imagine') return null;
  const result = { operation: value.operation, round: integer(value.round) };
  if (value.action !== undefined) {
    if (!actions.has(value.action)) return null;
    result.action = value.action;
    result.quoteId = text(value.quoteId, 100);
    result.name = text(value.name, 80);
    result.price = price(value.price);
    result.tier = tier(value.tier);
  } else if (typeof value.name === 'string') result.name = text(value.name, 40);
  return result;
}

export function privateMemoryContext(value = {}) {
  value ||= {};
  return {
    persona: text(value.persona, 600), strategy: normalizeStrategy(value.strategy, { strict: false }) || {},
    summary: text(value.summary, 1800),
    recentTurns: (Array.isArray(value.recentTurns) ? value.recentTurns : []).map(recentTurn).filter(Boolean).slice(-12),
    roundSummaries: (Array.isArray(value.roundSummaries) ? value.roundSummaries : []).slice(-10).map(publicRoundSummary).filter(Boolean),
    knownPrices: priceLedger(value.knownPrices),
  };
}

// This state is server-only. Nothing in this store is automatically added to a
// public GameRoom view; callers explicitly pass one player's snapshot to the AI.
export class AgentMemoryStore {
  constructor({ maxRecentTurns = 12, maxRoundSummaries = 10, maxKnownPrices = 256 } = {}) {
    this.maxRecentTurns = bounded(maxRecentTurns, 12, 12);
    this.maxRoundSummaries = bounded(maxRoundSummaries, 10, 10);
    this.maxKnownPrices = bounded(maxKnownPrices, 256, 256);
    this.rooms = new Map();
    this.tokens = new WeakMap();
  }

  _entry(roomSessionId, playerId, persona = '', create = false) {
    if (typeof roomSessionId !== 'string' || !roomSessionId || typeof playerId !== 'string' || !playerId) throw new Error('AI记忆需要房间会话和玩家身份');
    let room = this.rooms.get(roomSessionId);
    if (!room && create) { room = new Map(); this.rooms.set(roomSessionId, room); }
    let entry = room?.get(playerId);
    if (!entry && create) {
      entry = { generation: randomUUID(), revision: 0, persona: text(persona, 600), strategy: {}, summary: '', recentTurns: [], roundSummaries: [], knownPrices: [] };
      room.set(playerId, entry);
    }
    return entry;
  }

  begin({ roomSessionId, playerId, round, phase, persona = '' }) {
    const entry = this._entry(roomSessionId, playerId, persona, true);
    const token = Object.freeze({ id: randomUUID() });
    this.tokens.set(token, { roomSessionId, playerId, round, phase, generation: entry.generation, revision: entry.revision });
    return {
      token,
      memory: privateMemoryContext(entry),
    };
  }

  commit(token, result, { isCurrent = () => true } = {}) {
    const pending = this.tokens.get(token);
    if (!pending) return false;
    this.tokens.delete(token);
    const entry = this._entry(pending.roomSessionId, pending.playerId);
    if (!entry || entry.generation !== pending.generation || entry.revision !== pending.revision || !isCurrent()) return false;
    if (result?.operation === 'imagine') {
      const limit = result.action === undefined ? 40 : 80;
      if (typeof result.name !== 'string' || !result.name.trim() || [...result.name].length > limit) return false;
      if (result.action !== undefined && (!actions.has(result.action) || typeof result.quoteId !== 'string' || !result.quoteId.trim() || result.quoteId.length > 100 || !knownPrice({ ...result, round: pending.round, source: 'own-quote' }))) return false;
    }
    const turn = recentTurn({ ...result, round: pending.round });
    if (!turn) return false;
    const strategy = normalizeStrategy(result.strategy);
    if (strategy) entry.strategy = { ...entry.strategy, ...strategy };
    if (turn.action === 'quote') {
      entry.knownPrices = priceLedger([...entry.knownPrices, { ...turn, source: 'own-quote' }], this.maxKnownPrices);
    }
    entry.recentTurns.push(turn);
    entry.recentTurns = entry.recentTurns.slice(-this.maxRecentTurns);
    entry.revision++;
    return true;
  }

  recordRound(roomSessionId, result) {
    const summary = publicRoundSummary(result), room = this.rooms.get(roomSessionId);
    if (!summary || !room) return 0;
    let updated = 0;
    for (const entry of room.values()) {
      if (entry.roundSummaries.some(item => item.round === summary.round)) continue;
      entry.roundSummaries.push(clone(summary));
      entry.roundSummaries.sort((a, b) => a.round - b.round);
      entry.roundSummaries = entry.roundSummaries.slice(-this.maxRoundSummaries);
      entry.knownPrices = priceLedger([
        ...entry.knownPrices,
        ...summary.contributions.map(item => ({ ...item, round: summary.round, source: 'public-contribution' })),
        ...summary.products.map(item => ({ ...item, round: summary.round, source: 'public-product' })),
      ], this.maxKnownPrices);
      entry.summary = entry.roundSummaries.map(item => `第${item.round}轮：奖励${item.potValue ?? 0}金币，获得者${item.winnerId || '无'}；${item.players.map(player => `${player.name || player.id}结余${player.balance ?? '?'}${player.eliminated ? '（失败旁观）' : ''}`).join('，')}`).join('\n').slice(-1800);
      entry.revision++;
      updated++;
    }
    return updated;
  }

  snapshot(roomSessionId, playerId) {
    const entry = this._entry(roomSessionId, playerId);
    return entry ? { ...privateMemoryContext(entry), revision: entry.revision } : null;
  }

  clearPlayer(roomSessionId, playerId) {
    const room = this.rooms.get(roomSessionId);
    const removed = room?.delete(playerId) || false;
    if (room?.size === 0) this.rooms.delete(roomSessionId);
    return removed;
  }

  clearRoom(roomSessionId) { return this.rooms.delete(roomSessionId); }
}
