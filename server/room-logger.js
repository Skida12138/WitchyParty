import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const credentialKeys = new Set(['authorization', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'password', 'secret']);

function filePart(value) {
  const original = String(value);
  const safe = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 90);
  return safe === original ? safe : `${safe || 'room'}-${createHash('sha256').update(original).digest('hex').slice(0, 12)}`;
}

export class RoomLogger {
  constructor({ directory = path.resolve('logs/rooms'), secrets = [] } = {}) {
    this.directory = path.resolve(directory);
    this.secrets = [];
    this.addSecrets(...secrets);
    this.tail = Promise.resolve();
    this.directoryReady = false;
    this.warned = false;
  }

  addSecrets(...values) {
    for (const value of values.flat()) {
      if (typeof value === 'string' && value && !this.secrets.includes(value)) this.secrets.push(value);
    }
    this.secrets.sort((a, b) => b.length - a.length);
  }

  _string(value) {
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]');
    // Error bodies can echo credentials that were not part of the game data.
    return result
      .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/"(?:authorization|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret)"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"[credential]":"[REDACTED]"');
  }

  _sanitize(value, seen = new WeakSet(), depth = 0) {
    if (typeof value === 'string') return this._string(value);
    if (typeof value === 'bigint') return value.toString();
    if (value === null || typeof value !== 'object') return value;
    if (depth > 30) return '[Depth limit]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(item => this._sanitize(item, seen, depth + 1));
    else {
      result = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (credentialKeys.has(key.replace(/[^a-z]/gi, '').toLowerCase())) continue;
        result[this._string(key)] = this._sanitize(item, seen, depth + 1);
      }
    }
    seen.delete(value);
    return result;
  }

  _warn() {
    if (this.warned) return;
    this.warned = true;
    // Do not print the filesystem error: paths or upstream details may contain credentials.
    console.warn('房间调用日志暂时无法写入本地磁盘；游戏继续运行。');
  }

  _text(event) {
    const show = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const response = event.response;
    const lines = [
      `=== ${event.recordedAt} | ${event.actor?.label || '房间系统'} | ${event.operation || event.type} | ${event.status || event.type} ===`,
      `房间：${event.roomId} / ${event.roomSessionId}；轮次：${event.round ?? '-'}；圈次：${event.lap ?? '-'}`,
    ];
    if (event.requestId) lines.push(`请求：${event.requestId}`);
    if (event.model) lines.push(`模型：${event.model}`);
    if (event.thinking) lines.push(`思考模式：${event.thinking.type}${event.reasoningEffort ? `；强度：${event.reasoningEffort}` : ''}${event.maxTokens ? `；输出上限：${event.maxTokens}` : ''}`);
    if (event.source) lines.push(`来源：${event.source}`);
    if (event.reason) lines.push(`原因：${show(event.reason)}`);
    if (event.triggeredBy) lines.push(`触发玩家：${event.triggeredBy.name || event.triggeredBy.id || '-'}${event.triggeredBy.botIndex ? `（第 ${event.triggeredBy.botIndex} 位陪练）` : ''}`);
    if (event.startedAt) lines.push(`开始时间：${event.startedAt}`);
    if (event.completedAt) lines.push(`完成时间：${event.completedAt}`);
    if (event.durationMs !== undefined) lines.push(`耗时：${event.durationMs} ms`);
    if (event.httpStatus !== undefined) lines.push(`HTTP 状态：${event.httpStatus}`);
    if (event.request !== undefined) lines.push(`业务输入：\n${show(event.request)}`);
    if (response) {
      lines.push(`实际 reasoning_content：\n${response.reasoningContent === null || response.reasoningContent === undefined || response.reasoningContent === '' ? '（接口未返回推理内容）' : show(response.reasoningContent)}`);
      if (response.content !== undefined) lines.push(`实际返回内容：\n${show(response.content)}`);
      if (response.parsed !== undefined) lines.push(`解析结果：\n${show(response.parsed)}`);
      if (response.validated !== undefined) lines.push(`业务校验结果：\n${show(response.validated)}`);
      if (response.usage !== undefined) lines.push(`用量：${show(response.usage)}`);
      if (response.finishReason !== undefined) lines.push(`结束原因：${show(response.finishReason)}`);
      if (response.rawBody !== undefined) lines.push(`原始响应正文（已脱敏）：\n${show(response.rawBody)}`);
    }
    if (event.error) lines.push(`错误：${show(event.error)}`);
    return `${lines.join('\n')}\n\n`;
  }

  record(trace, event) {
    try {
      if (!trace?.roomId || !trace?.roomSessionId) return;
      const entry = this._sanitize({
        ...event,
        roomId: trace.roomId, roomSessionId: trace.roomSessionId, round: trace.round, lap: trace.lap,
        recordedAt: event.recordedAt || new Date().toISOString(),
      });
      const basename = `${filePart(entry.roomId)}-${filePart(entry.roomSessionId)}`;
      const jsonLine = `${JSON.stringify(entry)}\n`;
      const text = this._text(entry);
      this.tail = this.tail.then(async () => {
        if (!this.directoryReady) {
          await mkdir(this.directory, { recursive: true });
          this.directoryReady = true;
        }
        await appendFile(path.join(this.directory, `${basename}.jsonl`), jsonLine, 'utf8');
        await appendFile(path.join(this.directory, `${basename}.log`), text, 'utf8');
      }).catch(() => this._warn());
    } catch { this._warn(); }
  }

  async flush() {
    let pending;
    do { pending = this.tail; await pending; } while (pending !== this.tail);
  }
}
