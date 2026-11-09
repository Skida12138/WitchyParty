import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrategy, privateMemoryContext, publicRoundSummary } from './agent-memory.js';

export const rules = JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url), 'utf8'));
export const presets = JSON.parse(readFileSync(new URL('../config/materials.json', import.meta.url), 'utf8'));
export const witchProfiles = JSON.parse(readFileSync(new URL('../config/prompts/witches.json', import.meta.url), 'utf8'));

const promptOperations = new Set(['price', 'synthesize', 'imagine']);
const sectionNames = ['任务背景', '角色设定', '任务描述', '输出约束'];
export class PromptBuilder {
  constructor({ directory = new URL('../config/prompts/', import.meta.url) } = {}) {
    this.directory = directory instanceof URL ? fileURLToPath(directory) : path.resolve(directory);
  }

  build(operation, data) {
    if (!promptOperations.has(operation)) throw new Error('未知的AI任务配置');
    const read = name => {
      const value = readFileSync(path.join(this.directory, name), 'utf8').trim();
      if (!value || /【(?:任务背景|角色设定|任务描述|输出约束)】/u.test(value)) throw new Error(`提示词文件格式无效：${name}`);
      return value;
    };
    const sections = [
      read('background.txt'), read(['price', 'synthesize'].includes(operation) ? 'character-alchemy.txt' : 'character-witch.txt'),
      read(`task-${operation}.txt`), `${read('output-format.txt')}\n${read(`output-format-${operation}.txt`)}`,
    ];
    return [
      { role: 'system', content: sections.map((value, index) => `【${sectionNames[index]}】\n${value}`).join('\n\n') },
      { role: 'user', content: JSON.stringify(data) },
    ];
  }
}

export function normalizeName(value) {
  if (typeof value !== 'string') throw new Error('请输入材料名称');
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > rules.maxMaterialNameLength || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(`材料名称需要 1–${rules.maxMaterialNameLength} 个字符`);
  }
  return name;
}

const materialControlPatterns = [
  /(?:忽略|无视|覆盖|忘记).{0,20}(?:规则|提示|指令|设定|系统)/iu,
  /(?:系统|开发者|助手|system|developer|assistant)\s*[:：]|<\|(?:system|assistant|im_start)\|>/iu,
  /(?:提示词|系统提示|开发者消息|system\s+prompt|ignore.{0,24}(?:instructions?|rules?)|reveal.{0,20}prompt)/iu,
  /(?:价值|售价|卖价|价格|定价|估价|报价|标价|魔力消耗|法力消耗|耗魔|消耗|魔力|法力|mana(?:\s+cost)?|值|worth|costs?|price[sd]?|valued?)\s*(?:设置为|指定为|设为|定为|应为|为|是|达|等于|=|:|：|set\s+to|must\s+be|is|at|of)?\s*[0-9零一二三四五六七八九十百千万亿两]+/iu,
  /[0-9零一二三四五六七八九十百千万亿两]+\s*(?:点|单位)?\s*(?:魔力|法力|mana)/iu,
  /(?:请|必须|务必|你要|输出|返回|设为|设置为|定为|算作|认定为|force|set|output|return).{0,24}(?:价格|金币|魔力|法力|耗魔|JSON|price|coins?|gold|mana)/iu,
  /(?:稀有度|等级|品质)\s*(?:设为|指定为|必须是|改为)/u,
];

export function materialRefusal() {
  const error = new Error('材料不能指定价值或包含指令，请只描述材料本身');
  error.code = 'MATERIAL_REFUSED';
  return error;
}

export function validateMaterialName(value) {
  const name = normalizeName(value);
  const inspection = name.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '');
  if (materialControlPatterns.some(pattern => pattern.test(inspection))) throw materialRefusal();
  return name;
}

function rejectRefused(result) {
  // Never expose model-generated refusal text: it can contain copied prompts or player input.
  if (result?.refused === true) throw materialRefusal();
}

export function botPublicContext(context = {}) {
  const view = context.view || context;
  const me = view.me || { coins: context.coins, quotes: context.quotes };
  const revealed = ['resolving', 'performing', 'roundEnd', 'finished'].includes(view.phase);
  const material = item => ({ name: item.name, price: item.price, tier: item.tier });
  return {
    round: view.round, totalRounds: view.totalRounds, phase: view.phase,
    rules: { startingCoins: view.rules?.startingCoins ?? rules.startingCoins, maxQuotes: rules.maxQuotes, allowOverdraft: true, carryCoinsBetweenRounds: true, scoreEqualsCoins: true, eliminationAfterSettlement: 'coins<=0', reward: 'highest-original-contribution' },
    me: { id: me.id, coins: me.coins, quotes: (me.quotes || []).map(quote => ({ id: quote.id, name: quote.name, price: quote.price, tier: tierFor(quote.price) })), preparedQuoteId: me.preparedQuoteId ?? null },
    players: (view.players || []).map(player => ({ id: player.id, name: player.name, bot: player.bot, connected: player.connected, status: player.status, score: player.score, ready: player.ready })),
    contributions: revealed ? (view.contributions || []).map(item => ({ ownerId: item.ownerId, ...material(item), order: item.order })) : [],
    pot: revealed ? (view.pot || []).map(material) : [],
    completedRounds: (view.completedRounds || []).slice(-10).map(publicRoundSummary).filter(Boolean),
  };
}

function decisionContext(value = {}, game) {
  value ||= {};
  const bounded = (number, fallback, maximum) => Number.isSafeInteger(number) && number >= 0 ? Math.min(number, maximum) : fallback;
  const maxQuotes = bounded(value.maxQuotes, rules.maxQuotes, rules.maxQuotes);
  const available = Math.max(0, maxQuotes - game.me.quotes.length);
  const remainingQuotes = bounded(value.remainingQuotes, available, available);
  const remainingSteps = bounded(value.remainingSteps, 8, 8);
  const possible = remainingSteps > 0 ? [...(remainingQuotes > 0 ? ['quote'] : []), ...(game.me.quotes.length ? ['select'] : [])] : [];
  const allowedActions = possible.filter(action => !Array.isArray(value.allowedActions) || value.allowedActions.includes(action));
  return { allowedActions, maxQuotes, remainingQuotes, remainingSteps,
    feedback: typeof value.feedback === 'string' ? [...value.feedback.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()].slice(0, 200).join('') : '' };
}

function botRequestContext(context) {
  return { game: botPublicContext(context), memory: privateMemoryContext(context.memory) };
}

function synthesisInputs(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => !item || !Number.isSafeInteger(item.price) || item.price < 0 || item.price > rules.maxMaterialPrice)) throw new Error('合成原料信息无效');
  return value.map(item => ({ name: normalizeName(item.name), price: item.price }));
}

export function normalizePriceConstraint(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !['below', 'between', 'above'].includes(value.band)
    || !Number.isSafeInteger(value.minPrice) || !Number.isSafeInteger(value.maxPrice)
    || value.minPrice < 0 || value.minPrice > value.maxPrice || value.maxPrice > rules.maxMaterialPrice) {
    throw new Error('合成价格区间无效，请重新尝试');
  }
  return { band: value.band, minPrice: value.minPrice, maxPrice: value.maxPrice };
}

export function assertPriceInConstraint(price, constraint) {
  const bounds = normalizePriceConstraint(constraint);
  if (bounds && (!Number.isSafeInteger(price) || price < bounds.minPrice || price > bounds.maxPrice)) {
    throw Object.assign(new Error('合成材料价格不在本次允许区间内，请重新尝试'), { code: 'PRICE_CONSTRAINT_VIOLATION' });
  }
  return price;
}

export function tierFor(price) {
  return Object.entries(rules.tierMinimums).reverse().find(([, minimum]) => price >= minimum)?.[0] ?? 'white';
}

export function materialVector(name, seed) {
  const hash = createHash('sha256').update(normalizeName(name), 'utf8').update('\0').update(String(seed), 'utf8').digest();
  return Array.from({ length: 4 }, (_, group) => {
    let sum = 0;
    for (let offset = 0; offset < 8; offset += 2) sum += hash.readUInt16BE(group * 8 + offset);
    return ((sum % 65536) / 65535) * 2 - 1;
  });
}

export function reactionProbability(a, b, seed) {
  const va = materialVector(a, seed), vb = materialVector(b, seed);
  const base = Math.min(1, Math.hypot(...va.map((v, i) => v - vb[i])) / rules.probabilityDivisor);
  return base;
}

export class AlchemyProvider {
  constructor({ apiKey = process.env.DEEPSEEK_API_KEY, baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model = process.env.DEEPSEEK_MODEL || 'deepseek-flash', logger = null, botThinking = process.env.DEEPSEEK_BOT_THINKING !== 'disabled', promptDirectory, promptBuilder } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : undefined;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.mode = 'deepseek';
    this.botThinking = Boolean(botThinking);
    this.logger = logger;
    this.promptBuilder = promptBuilder || new PromptBuilder({ directory: promptDirectory });
    this.traceStorage = new AsyncLocalStorage();
    this.loggingWarning = false;
    try { this.logger?.addSecrets?.(this.apiKey); } catch { this._warnLogging(); }
  }

  get ready() { return Boolean(this.apiKey?.trim()); }

  withTrace(trace, fn) {
    const snapshot = trace ? { ...trace, player: trace.player ? { ...trace.player } : null } : null;
    return this.traceStorage.run(snapshot, fn);
  }

  _warnLogging() {
    if (this.loggingWarning) return;
    this.loggingWarning = true;
    console.warn('房间调用日志暂时无法记录；游戏继续运行。');
  }

  recordEvent(trace, event) {
    if (!this.logger) return;
    try {
      const current = trace ?? this.traceStorage.getStore();
      if (!current) return;
      const player = current.player ? { ...current.player } : null;
      const systemLabel = { price: '定价系统', synthesize: '合成系统' }[event.operation];
      const actor = systemLabel ? { kind: 'system', label: systemLabel }
        : event.operation === 'imagine' ? {
          kind: 'bot', label: player?.botIndex ? `第 ${player.botIndex} 位陪练（${player.name || 'AI 女巫'}）` : `AI 女巫（${player?.name || '未指定'}）`,
          playerId: player?.id ?? null, name: player?.name ?? null, botIndex: player?.botIndex ?? null,
        } : { kind: 'system', label: '房间系统' };
      const result = this.logger.record(current, { ...event, actor: event.actor || actor, triggeredBy: player, recordedAt: event.recordedAt || new Date().toISOString() });
      result?.catch?.(() => this._warnLogging());
    } catch { this._warnLogging(); }
  }

  _validateResponse(operation, result, context = {}) {
    rejectRefused(result);
    if (operation === 'price') {
      if (!Number.isSafeInteger(result.price) || result.price < 0 || result.price > rules.maxMaterialPrice) throw new Error('炼金顾问给出的价格无效，请重新尝试');
      assertPriceInConstraint(result.price, context.priceConstraint);
      return { price: result.price };
    }
    if (operation === 'synthesize') {
      const name = validateMaterialName(result.name);
      if ([...name].length > 40) throw new Error('AI材料名称需要 1–40 个字符');
      if (context.priceConstraint) {
        const known = (context.prices || presets).find(item => normalizeName(item.name) === name);
        if (known) assertPriceInConstraint(known.price, context.priceConstraint);
      }
      return { name };
    }
    if (operation === 'imagine') {
      try {
        const game = botPublicContext(context), decision = decisionContext(context.decision, game);
        if (!['quote', 'select'].includes(result.action) || !decision.allowedActions.includes(result.action)) throw new Error('AI选材动作无效');
        let validated;
        if (result.action === 'quote') validated = { action: 'quote', name: validateMaterialName(result.name) };
        else {
          if (typeof result.quoteId !== 'string' || !game.me.quotes.some(quote => quote.id === result.quoteId)) throw new Error('AI只能选择自己本轮已报价的候选');
          validated = { action: 'select', quoteId: result.quoteId };
        }
        if (result.strategy !== undefined) validated.strategy = normalizeStrategy(result.strategy);
        return validated;
      } catch (error) {
        if (error.code !== 'MATERIAL_REFUSED') error.code = 'AI_DECISION_INVALID';
        throw error;
      }
    }
    throw new Error('未知的AI任务');
  }

  async _request(operation, data, { validate = value => this._validateResponse(operation, value) } = {}) {
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const useThinking = this.botThinking && operation === 'imagine';
    const thinking = { type: useThinking ? 'enabled' : 'disabled' };
    const maxTokens = useThinking ? 4096 : 512;
    const reasoningEffort = useThinking ? 'low' : null;
    const common = { operation, requestId, startedAt, model: this.model, thinking, reasoningEffort, maxTokens, request: data };
    const responseLog = { content: null, reasoningContent: null };
    let httpStatus;
    let status = 'configuration_error';
    this.recordEvent(null, { ...common, type: 'started', status: 'started' });
    try {
      if (!this.ready) throw new Error('服务器尚未配置 DeepSeek 密钥，请设置 DEEPSEEK_API_KEY 后重启服务');
      const messages = this.promptBuilder.build(operation, data);
      let response;
      status = 'network_error';
      try {
        const roomSignal = this.traceStorage.getStore()?.signal;
        const timeoutSignal = AbortSignal.timeout(25000);
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          signal: roomSignal ? AbortSignal.any([roomSignal, timeoutSignal]) : timeoutSignal,
          body: JSON.stringify({ model: this.model, thinking, ...(useThinking ? { reasoning_effort: reasoningEffort } : {}), ...(!useThinking ? { temperature: 0.65 } : {}), max_tokens: maxTokens, response_format: { type: 'json_object' }, messages }),
        });
        httpStatus = response.status;
        responseLog.rawBody = await response.text();
      } catch {
        throw new Error('炼金顾问暂时不可用，请稍后重试；本次不消耗构想次数或金币');
      }
      if (!response.ok) {
        status = 'http_error';
        throw new Error(`炼金顾问请求失败（${response.status}），请检查服务器的 DeepSeek 配置`);
      }
      status = 'invalid_json';
      let parsed;
      try {
        const payload = JSON.parse(responseLog.rawBody);
        const choice = payload.choices?.[0];
        responseLog.content = choice?.message?.content ?? null;
        responseLog.reasoningContent = choice?.message?.reasoning_content ?? null;
        responseLog.usage = payload.usage ?? null;
        responseLog.finishReason = choice?.finish_reason ?? null;
        parsed = JSON.parse(responseLog.content);
        responseLog.parsed = parsed;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid response');
      } catch {
        throw new Error('炼金顾问返回了无效结果，请重新尝试');
      }
      status = 'validation_error';
      const result = await validate(parsed);
      responseLog.validated = result;
      this.recordEvent(null, { ...common, type: 'completed', status: 'success', completedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - started) * 100) / 100, httpStatus, response: responseLog });
      return result;
    } catch (error) {
      if (error?.code === 'MATERIAL_REFUSED') status = 'refused';
      else if (operation === 'imagine' && ['invalid_json', 'validation_error'].includes(status)) error.code = 'AI_DECISION_INVALID';
      this.recordEvent(null, { ...common, type: 'completed', status, completedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - started) * 100) / 100, httpStatus, response: responseLog, error: error.message });
      throw error;
    }
  }

  async price(rawName, context = {}) {
    const priceConstraint = normalizePriceConstraint(context.priceConstraint);
    let name;
    try { name = validateMaterialName(rawName); }
    catch (error) {
      this.recordEvent(null, { type: 'rejected', operation: 'price', status: error.code === 'MATERIAL_REFUSED' ? 'refused' : 'validation_error', request: { material: rawName }, durationMs: 0, error: error.message });
      throw error;
    }
    const exact = (context.prices || presets).find(item => normalizeName(item.name) === name);
    if (exact) {
      assertPriceInConstraint(exact.price, priceConstraint);
      const result = { name, price: exact.price, source: 'cache' };
      this.recordEvent(null, { type: 'cache_hit', operation: 'price', status: 'cache', source: context.prices ? 'cache' : 'preset', request: { material: name }, response: { content: JSON.stringify(result), reasoningContent: null, parsed: result }, durationMs: 0 });
      return result;
    }
    const inputs = context.synthesisInputs === undefined ? null : synthesisInputs(context.synthesisInputs);
    const result = await this._request('price', {
      material: name, prices: context.prices || presets, synthesisHistory: context.history || [],
      ...(inputs ? { source: 'synthesis', synthesisInputs: inputs, inputTotal: inputs.reduce((sum, item) => sum + item.price, 0) } : {}),
      ...(priceConstraint ? { priceConstraint } : {}),
    }, { validate: value => this._validateResponse('price', value, { priceConstraint }) });
    return { name, price: result.price, source: 'deepseek' };
  }

  async synthesize(a, b, context = {}) {
    const priceConstraint = normalizePriceConstraint(context.priceConstraint);
    const ingredients = synthesisInputs([a, b]);
    const prices = context.prices || presets;
    const result = await this._request('synthesize', {
      ingredients, inputTotal: ingredients.reduce((sum, item) => sum + item.price, 0), synthesisHistory: context.history || [], prices,
      ...(priceConstraint ? { priceConstraint } : {}),
    }, { validate: value => this._validateResponse('synthesize', value, { priceConstraint, prices }) });
    return { name: result.name, source: 'deepseek' };
  }

  async imagine(context = {}) {
    const game = botPublicContext(context), decision = decisionContext(context.decision, game);
    const result = await this._request('imagine', { ...botRequestContext(context), decision, referenceNames: presets.map(p => p.name) }, { validate: value => this._validateResponse('imagine', value, { ...context, decision }) });
    return { ...result, source: 'deepseek' };
  }

}
