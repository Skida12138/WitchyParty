import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const constraintSuffix = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8).replace(/[0-9a-f]/g, letter => '星月风露花叶云雪雨光梦影铃萤竹羽'[parseInt(letter, 16)]);

// A test-only local HTTP service. It exercises the production provider without
// an external request or a token charge, and is never offered as a game mode.
export async function createDeepSeekStub({ responses = {}, prices = {} } = {}) {
  const requests = [], gates = new Map(), failures = new Map();
  let ideas = 0;
  const api = createServer(async (req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    try {
      let input = '';
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input), data = JSON.parse(body.messages.findLast(message => message.role === 'user').content);
      const operation = typeof data.material === 'string' ? 'price' : Array.isArray(data.ingredients) ? 'synthesize' : data.decision || Array.isArray(data.referenceNames) ? 'imagine' : 'unknown';
      const request = { body, data, operation, authorization: req.headers.authorization, receivedAt: Date.now(), closedWithoutResponse: false };
      requests.push(request);
      res.on('close', () => { request.closedWithoutResponse = !res.writableEnded; request.closedAt = Date.now(); });
      const gate = gates.get(`${operation}:${data.material || ''}`) || gates.get(operation);
      if (gate) { gate.enteredResolve(); await gate.promise; }
      if ((failures.get(operation) || 0) > 0 || data.material === '接口故障测试材料') {
        failures.set(operation, Math.max(0, (failures.get(operation) || 0) - 1));
        res.writeHead(503); res.end('{"error":"PRIVATE_UPSTREAM_AI_FAILURE"}'); return;
      }
      const defaults = {
        imagine: () => data.game.me.quotes.length ? { action: 'select', quoteId: data.game.me.quotes[0].id } : { action: 'quote', name: `杯底的第${++ideas}颗流星`, strategy: { goal: '留下一些金币，再观察对手', risk: 'balanced' } },
        synthesize: () => ({ name: `灯芯里的小雨燕${data.priceConstraint ? `·${constraintSuffix(data.priceConstraint)}` : ''}` }),
        price: () => {
          const price = prices[data.material] ?? 80, constraint = data.priceConstraint;
          return { price: constraint ? Math.max(constraint.minPrice, Math.min(constraint.maxPrice, price)) : price };
        },
      };
      const response = responses[operation] ? await responses[operation](data, request, requests) : defaults[operation]();
      request.response = response;
      request.completedAt = Date.now();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'test-completion', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(response), reasoning_content: operation === 'imagine' ? 'Test-only private reasoning.' : undefined } }] }));
    } catch { if (!res.headersSent) res.writeHead(400); res.end('{"error":"invalid test request"}'); }
  });
  await new Promise((resolve, reject) => api.listen(0, '127.0.0.1', resolve).once('error', reject));
  const hold = key => {
    let enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const promise = new Promise(resolve => { release = resolve; });
    gates.set(key, { enteredResolve, promise, release });
    return { entered, release() { gates.delete(key); release(); } };
  };
  return {
    url: `http://127.0.0.1:${api.address().port}`, requests,
    get ideas() { return ideas; },
    count: operation => requests.filter(request => request.operation === operation).length,
    failNext: (operation, count = 1) => failures.set(operation, count),
    hold, holdMaterial: name => hold(`price:${name}`),
    close: () => new Promise(resolve => { for (const gate of gates.values()) gate.release(); api.closeAllConnections(); api.close(resolve); }),
  };
}
