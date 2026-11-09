import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GameRoom } from './game.js';
import { AlchemyProvider, rules, validateMaterialName, witchProfiles } from './alchemy.js';
import { RoomLogger } from './room-logger.js';
import { AgentMemoryStore } from './agent-memory.js';
import { allowedSocketOrigin, createInviteAccess, INVITE_PROTOCOL, inviteHashFromProtocols } from './invite-access.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roomLogger = process.env.ROOM_LOG_ENABLED === '0' ? null : new RoomLogger({
  directory: path.resolve(root, process.env.ROOM_LOG_DIR || 'logs/rooms'),
  secrets: [process.env.DEEPSEEK_API_KEY, process.env.INVITE_CODE_SHA256, process.env.INVITE_CODE_SHA256?.toLowerCase()].filter(Boolean),
});
const provider = new AlchemyProvider({
  logger: roomLogger,
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
});
const app = express();
const inviteAccess = createInviteAccess(process.env.INVITE_CODE_SHA256);
app.disable('x-powered-by');
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try { inviteAccess.assertHash(req.headers['x-invite-hash']); next(); }
  catch (error) { res.status(error.status).json({ ok: false, code: error.code, message: error.message }); }
});
app.get('/api/access', (_req, res) => res.json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: provider.mode, aiReady: provider.ready, version: '0.1.0' }));
app.use(express.static(path.join(root, 'dist')));
app.get('/', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: 8192, handleProtocols: protocols => protocols.has(INVITE_PROTOCOL) ? INVITE_PROTOCOL : false });
wss.on('headers', headers => headers.push('Cache-Control: no-store'));
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const reject = (status, code, message) => {
    const body = JSON.stringify({ ok: false, code, message });
    const reason = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }[status];
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  try { inviteAccess.assertHash(inviteHashFromProtocols(req.headers['sec-websocket-protocol'])); }
  catch (error) { reject(error.status, error.code, error.message); return; }
  if (!allowedSocketOrigin(req.headers.origin, req.headers.host)) { reject(403, 'ORIGIN_INVALID', '来源不匹配'); return; }
  if (req.url?.split('?')[0] !== '/ws') { reject(404, 'NOT_FOUND', '连接地址不存在'); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
const rooms = new Map();
const connections = new Map();
const agentMemory = new AgentMemoryStore();
const MAX_PLAYERS = 8;
const MAX_BOT_DECISION_STEPS = 8;
const intervalSetting = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 20 ? value : fallback;
};
const RECONNECT_GRACE_MS = intervalSetting('RECONNECT_GRACE_MS', 30000);
const HEARTBEAT_INTERVAL_MS = intervalSetting('HEARTBEAT_INTERVAL_MS', 10000);
const HEARTBEAT_TIMEOUT_MS = intervalSetting('HEARTBEAT_TIMEOUT_MS', 10000);

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function fail(message, code = 'ACTION_FAILED') { throw Object.assign(new Error(message), { code }); }
function nameOf(value) {
  if (typeof value !== 'string') fail('请输入女巫昵称');
  const name = value.normalize('NFKC').trim();
  if (!name || [...name].length > 16 || /[\p{Cc}\p{Cf}]/u.test(name)) fail('昵称需要 1–16 个可见字符');
  return name;
}
function roomCode() {
  let code;
  do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function activeRoom(code) {
  const record = rooms.get(code);
  if (record && !hasConnectedHumans(record) && record.emptySince !== null && Date.now() - record.emptySince >= RECONNECT_GRACE_MS) {
    destroyRoom(record);
    return undefined;
  }
  return record;
}
function enqueue(record, operation) {
  const task = record.queue.then(() => {
    if (record.game.disposed) fail('这场集会已经结束，请重新创建房间。', 'ROOM_CLOSED');
    return operation();
  });
  record.queue = task.catch(() => {});
  return task;
}
function broadcast(record) {
  if (record.game.disposed) return;
  pruneDepartures(record);
  if (record.game.roundResult && record.memoryRound !== record.game.roundResult.round) {
    agentMemory.recordRound(record.game.roomSessionId, record.game.roundResult);
    record.memoryRound = record.game.roundResult.round;
  }
  record.touched = Date.now();
  for (const [id, ws] of record.sockets) send(ws, { type: 'state', state: stateFor(record, id) });
  updateRoomActivity(record);
  scheduleAutomation(record);
}
function stateFor(record, playerId) {
  return record.game.view(playerId);
}
function hasConnectedHumans(record) {
  return record.game.players.some(player => !player.bot && !player.departurePending && record.sockets.get(player.id)?.readyState === WebSocket.OPEN);
}
function updateRoomActivity(record) {
  if (record.game.disposed) return;
  if (hasConnectedHumans(record)) record.emptySince = null;
  else {
    record.emptySince ??= Date.now();
    clearTimeout(record.timer);
    record.timer = null;
  }
}
function pruneDepartures(record) {
  const currentIds = new Set(record.game.players.filter(player => !player.departurePending).map(player => player.id));
  for (const id of record.tokens.keys()) {
    if (currentIds.has(id)) continue;
    record.tokens.delete(id);
    record.disconnected.delete(id);
    const ws = record.sockets.get(id);
    if (ws) {
      record.sockets.delete(id);
      connections.delete(ws);
      send(ws, { type: 'session_ended', code: 'PLAYER_REMOVED', message: '你已离开这场集会，请返回大厅。' });
      ws.close(4003, '已离开集会');
    }
  }
  for (const id of record.personas.keys()) {
    if (currentIds.has(id)) continue;
    agentMemory.clearPlayer(record.game.roomSessionId, id);
    record.botPreparations.delete(id);
    record.personas.delete(id);
  }
}
function destroyRoom(record) {
  if (record.game.disposed) return;
  rooms.delete(record.game.id);
  clearTimeout(record.timer);
  record.timer = null;
  record.game.dispose();
  agentMemory.clearRoom(record.game.roomSessionId);
  record.botPreparations.clear();
  for (const ws of record.sockets.values()) {
    connections.delete(ws);
    send(ws, { type: 'session_ended', code: 'ROOM_CLOSED', message: '这场集会已结束，请重新创建房间。' });
    ws.close(4003, '房间已关闭');
  }
  record.sockets.clear();
  record.tokens.clear();
  record.disconnected.clear();
}
function disconnect(ws, { explicit = false } = {}) {
  const session = connections.get(ws);
  connections.delete(ws);
  if (!session || session.record.game.disposed || session.record.sockets.get(session.playerId) !== ws) return;
  const { record, playerId } = session;
  record.sockets.delete(playerId);
  record.disconnected.set(playerId, Date.now());
  if (explicit) {
    record.tokens.delete(playerId);
    record.disconnected.delete(playerId);
    record.game.markDeparting(playerId, { reason: 'leave' });
  } else record.game.setConnected(playerId, false);
  updateRoomActivity(record);
  scheduleAutomation(record);
}
function bind(ws, record, playerId, token) {
  if (record.game.disposed) fail('这场集会已经结束，请重新创建房间。', 'ROOM_CLOSED');
  const previous = record.sockets.get(playerId);
  if (previous && previous !== ws) { connections.delete(previous); previous.close(4001, '已在另一窗口连接'); }
  connections.set(ws, { record, playerId });
  record.sockets.set(playerId, ws);
  record.disconnected.delete(playerId);
  record.emptySince = null;
  send(ws, { type: 'session', roomId: record.game.id, playerId, token });
  record.game.setConnected(playerId, true);
  broadcast(record);
}
function makeRoom(rounds) {
  const game = new GameRoom({
    id: roomCode(), rounds, provider,
    ...(process.env.DEPOSIT_MS !== undefined ? { depositMs: Number(process.env.DEPOSIT_MS) } : {}),
    ...(process.env.REACTION_MS !== undefined ? { reactionMs: Number(process.env.REACTION_MS) } : {}),
    ...(process.env.HOLD_MS !== undefined ? { holdMs: Number(process.env.HOLD_MS) } : {}),
    ...(process.env.CHAIN_HOLD_MS !== undefined ? { chainHoldMs: Number(process.env.CHAIN_HOLD_MS) } : {}),
  });
  const record = {
    game, queue: Promise.resolve(), sockets: new Map(), tokens: new Map(), disconnected: new Map(),
    timer: null, touched: Date.now(), emptySince: null, jobs: new Map(), personas: new Map(), botPreparations: new Map(),
    memoryRound: null,
  };
  rooms.set(game.id, record);
  game.on('change', () => broadcast(record));
  return record;
}
function addBot(record) {
  if (record.game.phase !== 'lobby') fail('游戏开始后不能添加 AI 女巫');
  if (!record.game.provider.ready) fail('服务器尚未配置 DeepSeek 密钥，暂时无法添加 AI 女巫，请设置 DEEPSEEK_API_KEY 后重启服务');
  if (record.game.players.length >= MAX_PLAYERS) fail('房间已满（最多 8 人）');
  const names = new Set(record.game.players.map(p => p.name));
  const profile = witchProfiles.find(item => !names.has(item.name)) || { ...witchProfiles[0], name: `AI 女巫 ${record.game.players.length}` };
  const player = record.game.addPlayer(profile.name, { bot: true });
  record.personas.set(player.id, profile.persona);
}
function scheduleAutomation(record) {
  if (record.timer || record.game.phase !== 'preparing' || !hasConnectedHumans(record) || record.game.disposed || !record.game.players.some(player => player.bot && player.status === 'active' && player.connected && !player.departurePending)) return;
  record.timer = setTimeout(() => {
    record.timer = null;
    automate(record);
  }, 700);
  record.timer.unref();
}
function runAIJob(record, player, kind, operation) {
  if (record.jobs.has(player.id)) return;
  const game = record.game, round = game.round, phase = game.phase;
  const job = { kind, round, phase };
  record.jobs.set(player.id, job);
  Promise.resolve().then(() => operation(job)).catch(error => {
    if (game.disposed || game.round !== round || game.phase !== phase || !game.players.includes(player) || player.departurePending) return;
    game.provider.recordEvent?.(game.aiTrace(player), { type: 'player_disconnected', status: 'ai_unavailable', error: error.message });
    game.markDeparting(player.id, { reason: 'ai-unavailable' });
  }).finally(() => { if (record.jobs.get(player.id) === job) record.jobs.delete(player.id); scheduleAutomation(record); });
}
function agentTurn(record, player) {
  return agentMemory.begin({
    roomSessionId: record.game.roomSessionId, playerId: player.id, round: record.game.round, phase: record.game.phase,
    persona: record.personas.get(player.id),
  });
}

function decisionFailure(code, message) { return Object.assign(new Error(message), { code }); }

async function prepareBot(record, player, canContinue) {
  const game = record.game, round = game.round;
  // Keep the budget across a paused job/reconnection, and reset only for a new round.
  let preparation = record.botPreparations.get(player.id);
  if (!preparation || preparation.round !== round) {
    preparation = { round, steps: 0, feedback: null };
    record.botPreparations.set(player.id, preparation);
  }
  const isCurrent = () => !game.disposed && game.round === round && game.phase === 'preparing' && game.players.includes(player) && player.connected && !player.departurePending && player.status === 'active' && !player.preparedQuoteId;
  while (canContinue() && isCurrent() && preparation.steps < MAX_BOT_DECISION_STEPS) {
    const view = game.view(player.id), quotes = view.me.quotes;
    const remainingSteps = MAX_BOT_DECISION_STEPS - preparation.steps;
    const allowedActions = quotes.length === 0 ? ['quote']
      : quotes.length >= rules.maxQuotes || remainingSteps === 1 ? ['select'] : ['quote', 'select'];
    const turn = agentTurn(record, player);
    preparation.steps += 1;
    try {
      const choice = await game.withAITrace(player.id, () => game.provider.imagine({
        view, memory: turn.memory,
        decision: { allowedActions, maxQuotes: rules.maxQuotes, remainingQuotes: rules.maxQuotes - quotes.length, remainingSteps, feedback: preparation.feedback },
      }));
      if (!canContinue() || !isCurrent()) return;
      if (!allowedActions.includes(choice.action)) throw decisionFailure('AI_DECISION_INVALID', '请选择当前允许的操作');
      if (choice.action === 'quote') {
        const name = validateMaterialName(choice.name);
        if (player.quotes.some(quote => quote.name === name)) throw decisionFailure('DUPLICATE_CANDIDATE', '该材料已经在本轮候选中，请选择它或构想另一份材料');
        const quoteIndex = player.quotes.length;
        await game.action(player.id, 'quote', { name });
        if (!isCurrent()) return;
        const quote = player.quotes[quoteIndex];
        // Only the actual server quote may enter price memory, never model-supplied prices.
        agentMemory.commit(turn.token, { operation: 'imagine', action: 'quote', quoteId: quote.id, name: quote.name, price: quote.price, tier: quote.tier, strategy: choice.strategy }, { isCurrent });
        preparation.feedback = null;
      } else {
        const quote = player.quotes.find(item => item.id === choice.quoteId);
        if (!quote) throw decisionFailure('AI_DECISION_INVALID', '只能选择自己本轮候选材料的编号');
        await game.action(player.id, 'commit', { quoteId: quote.id });
        agentMemory.commit(turn.token, { operation: 'imagine', action: 'select', quoteId: quote.id, name: quote.name, price: quote.price, tier: quote.tier, strategy: choice.strategy }, {
          isCurrent: () => !game.disposed && game.round === round && game.players.includes(player) && player.preparedQuoteId === quote.id,
        });
        return;
      }
    } catch (error) {
      if (!isCurrent()) return;
      const feedback = {
        MATERIAL_REFUSED: '材料被拒绝，请只描述材料本身，不要指定价值或包含指令。成功候选名额未减少。',
        AI_DECISION_INVALID: '上一步操作无效。请遵守allowedActions；选择时使用自己本轮已有的候选编号。',
        DUPLICATE_CANDIDATE: '该材料已在本轮候选中。请选择它，或询价一个不同名称；候选名额未减少。',
      }[error.code];
      if (!feedback) throw error;
      preparation.feedback = feedback;
      game.provider.recordEvent?.(game.aiTrace(player), { type: 'decision_retry', operation: 'imagine', status: error.code, step: preparation.steps, feedback });
    }
  }
  if (canContinue() && isCurrent()) throw decisionFailure('AI_DECISION_EXHAUSTED', 'AI女巫未能在本轮决策次数内选定材料');
}

function automate(record) {
  const game = record.game;
  if (game.disposed || !hasConnectedHumans(record)) return;
  const automated = player => player?.bot && player.connected && !player.departurePending;
  const round = game.round, phase = game.phase;
  const samePhase = () => !game.disposed && hasConnectedHumans(record) && game.round === round && game.phase === phase;

  if (game.phase === 'preparing') {
    for (const player of game.players.filter(player => player.status === 'active' && automated(player))) {
      const view = game.view(player.id);
      if (view.me.preparedQuoteId || view.me.quoteBusy) continue;
      runAIJob(record, player, 'prepare', async () => {
        const stillPreparing = () => samePhase() && game.players.includes(player) && automated(player) && player.status === 'active' && !player.preparedQuoteId;
        await prepareBot(record, player, stillPreparing);
      });
    }
  }
  scheduleAutomation(record);
}

wss.on('connection', ws => {
  let recent = [];
  let busy = false;
  ws.presence = { nextPing: Date.now() + HEARTBEAT_INTERVAL_MS, awaitingPongSince: null };
  ws.on('pong', () => {
    ws.presence.awaitingPongSince = null;
    ws.presence.nextPing = Date.now() + HEARTBEAT_INTERVAL_MS;
  });
  ws.on('message', async raw => {
    if (ws.readyState !== WebSocket.OPEN) return;
    let message;
    let acquired = false;
    try {
      try { message = JSON.parse(raw.toString()); } catch { inviteAccess.assertHash(null); }
      inviteAccess.assertHash(message?.inviteHash);
      if (!message || typeof message !== 'object' || Array.isArray(message)) fail('消息格式无效');
      const now = Date.now();
      recent = recent.filter(t => now - t < 10000);
      if (recent.length >= 60) fail('操作太快，请稍后重试');
      recent.push(now);
      const p = message.payload || {};
      if (!p || typeof p !== 'object' || Array.isArray(p)) fail('操作参数无效');
      const existing = connections.get(ws);
      // Leaving must not wait behind a material request. The in-flight action
      // will validate the player's departure before applying its result.
      if (message.type === 'leave') {
        if (existing) disconnect(ws, { explicit: true });
        send(ws, { type: 'ack', requestId: message.requestId });
        return;
      }
      if (message.type === 'chat') fail('房间聊天已关闭。', 'CHAT_DISABLED');
      if (busy) fail('上一项操作仍在处理');
      busy = true;
      acquired = true;
      if (['create', 'join', 'resume'].includes(message.type) && existing) fail('你已在房间中，请先离开');
      if (message.type === 'create') {
        if (p.demo) fail('独立陪练房间已取消，请创建普通房间后添加 AI 女巫');
        if (rooms.size >= 100) fail('房间暂时已满');
        const name = nameOf(p.name);
        if (![3, 5, 10].includes(p.rounds)) fail('请选择 3、5 或 10 轮');
        const record = makeRoom(p.rounds);
        const player = record.game.addPlayer(name);
        const token = randomBytes(32).toString('hex');
        record.tokens.set(player.id, token);
        bind(ws, record, player.id, token);
      } else if (message.type === 'join') {
        const record = activeRoom(String(p.roomId).trim().toUpperCase());
        if (!record) fail('找不到这个房间，请检查房间码');
        const name = nameOf(p.name);
        await enqueue(record, () => {
          if (record.game.phase !== 'lobby') fail('对局已经开始，请等待下一场');
          if (record.game.players.length >= MAX_PLAYERS) fail('房间已满（最多 8 人）');
          if (record.game.players.some(q => q.name === name)) fail('房间内已有这个昵称');
          const player = record.game.addPlayer(name);
          const token = randomBytes(32).toString('hex');
          record.tokens.set(player.id, token);
          bind(ws, record, player.id, token);
        });
      } else if (message.type === 'resume') {
        const record = activeRoom(String(p.roomId));
        if (!record || record.game.disposed) fail('这场集会已关闭，请重新创建或加入房间。', 'ROOM_CLOSED');
        const expected = record?.tokens.get(p.playerId);
        if (!expected || typeof p.token !== 'string' || Buffer.byteLength(p.token) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(expected), Buffer.from(p.token))) fail('房间身份已失效，请返回大厅。', 'SESSION_EXPIRED');
        if (!record.game.players.some(player => player.id === p.playerId && !player.departurePending)) fail('你已离开这场集会，请返回大厅。', 'PLAYER_REMOVED');
        const disconnectedAt = record.disconnected.get(p.playerId);
        if (disconnectedAt !== undefined && Date.now() - disconnectedAt >= RECONNECT_GRACE_MS) {
          record.game.markDeparting(p.playerId);
          fail('重连时间已过，你已离开这场集会。', 'PLAYER_REMOVED');
        }
        bind(ws, record, p.playerId, expected);
      } else if (message.type === 'action') {
        if (!existing) fail('请先加入房间');
        const { record, playerId } = existing;
        if (['quote', 'commit', 'unready', 'retryCommit'].includes(p.action)) {
          // Network-bound preparation is independent per player, never a room-wide queue.
          await record.game.action(playerId, p.action, p);
        } else await enqueue(record, async () => {
          if (p.action === 'addBot') {
            if (record.game.hostId !== playerId) fail('只有房主可以添加 AI 女巫');
            addBot(record);
          } else if (['start', 'nextRound'].includes(p.action)) {
            await record.game.action(playerId, p.action, p);
          } else fail('不支持的操作');
        });
      } else fail('不支持的消息');
      send(ws, { type: 'ack', requestId: message.requestId });
    } catch (error) {
      send(ws, { type: 'error', requestId: message?.requestId, code: error.code || 'ACTION_FAILED', message: error.message || '操作失败，请重试' });
      if (['INVITE_INVALID', 'INVITE_NOT_CONFIGURED'].includes(error.code)) ws.close(4004, '邀请码无效');
    } finally { if (acquired) busy = false; }
  });
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => {});
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const presence = ws.presence;
    if (!presence || ws.readyState !== WebSocket.OPEN) continue;
    if (presence.awaitingPongSince !== null) {
      if (now - presence.awaitingPongSince >= HEARTBEAT_TIMEOUT_MS) { disconnect(ws); ws.terminate(); }
    } else if (now >= presence.nextPing) {
      presence.awaitingPongSince = now;
      ws.ping();
    }
  }
  for (const record of rooms.values()) {
    updateRoomActivity(record);
    if (record.emptySince !== null && now - record.emptySince >= RECONNECT_GRACE_MS) {
      destroyRoom(record);
      continue;
    }
    for (const [id, disconnectedAt] of record.disconnected) {
      if (now - disconnectedAt < RECONNECT_GRACE_MS) continue;
      record.disconnected.delete(id);
      if (record.game.players.some(player => player.id === id && !player.departurePending)) record.game.markDeparting(id);
    }
  }
}, Math.max(20, Math.min(1000, RECONNECT_GRACE_MS / 4, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS)));
cleanup.unref();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Witchy Party: http://${host}:${port} (deepseek; AI ${provider.ready ? 'configured' : 'not configured'})`));
async function shutdown() {
  clearInterval(cleanup);
  for (const record of rooms.values()) destroyRoom(record);
  for (const ws of wss.clients) ws.close(1001, '服务器停止');
  wss.close(); server.close();
  await roomLogger?.flush();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
