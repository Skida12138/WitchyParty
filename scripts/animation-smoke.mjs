import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/game.js';
import { quoteAndReady } from '../tests/helpers/game-fixture.js';
import { seedInvite } from './helpers/invite-fixture.mjs';

// A deterministic local GameRoom drives the real browser through the WS route.
// There is no external model, production session, or provider network request.
const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const report = { ok: false, baseURL, deterministicGameRoom: true, realModelCalls: 0, checks: [], errors: [], consoleErrors: [], consoleWarnings: [] };
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const requestedScenarios = process.env.ANIMATION_SCENARIOS?.split(',') || (process.env.TEST_MOBILE === '1' ? ['mobile'] : null);
const sizes = [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['reduced-mobile', { width: 390, height: 844 }]].filter(([name]) => !requestedScenarios || requestedScenarios.includes(name));
assert.ok(sizes.length, 'At least one animation scenario must be selected');
const until = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(15); }
};
const absentChat = async page => { await expect(page.locator('.room-chat,[data-chat-root],.chat-toggle')).toHaveCount(0); await expect(page.getByRole('textbox', { name: '聊天消息', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: /聊天/ })).toHaveCount(0); };
const sample = page => page.evaluate(() => {
  const board = document.querySelector('.presentation-board');
  const holding = board?.dataset.holding === 'true';
  return {
    at: Date.now(),
    id: board?.dataset.presentationId, index: Number(board?.dataset.presentationIndex), kind: board?.dataset.presentationKind,
    elapsed: Number(board?.dataset.elapsedMs), duration: Number(board?.dataset.durationMs), progress: Number(board?.dataset.progress),
    motionProgress: Number(board?.dataset.motionProgress), holding,
    particles: document.querySelectorAll('.presentation-flight-particle').length,
    visibleParticles: [...document.querySelectorAll('.presentation-flight-particle')].filter(node => Number(getComputedStyle(node).opacity) > .05).length,
    reserved: document.querySelectorAll('.presentation-reserved-slot').length,
    reactants: document.querySelectorAll('.presentation-reactant').length,
    product: document.querySelector('.presentation-product')?.dataset.visible,
    overflow: document.documentElement.scrollWidth > innerWidth,
    ranks: document.querySelectorAll('.coin-rank-row').length,
    publicCards: document.querySelectorAll('.public-card,.public-materials,.round-stirring').length,
    cards: holding ? [...document.querySelectorAll('.presentation-card')].map(node => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { id: node.dataset.materialId, opacity: style.opacity, filter: style.filter, transform: style.transform, x: box.x, y: box.y, width: box.width, height: box.height };
    }) : [],
  };
});
const inspectFlight = (page, playerId) => page.evaluate(id => {
  const point = node => { const box = node?.getBoundingClientRect(); return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null; };
  const layer = document.querySelector('.presentation-particles'), particle = document.querySelector('.presentation-flight-particle.is-leading');
  return { sourceX: Number(layer?.dataset.sourceX), sourceY: Number(layer?.dataset.sourceY), targetX: Number(layer?.dataset.targetX), targetY: Number(layer?.dataset.targetY), avatar: point(document.querySelector(`[data-player-id="${id}"] .circle-avatar`)), target: point(document.querySelector('.presentation-reserved-slot')), particle: point(particle), opacity: particle ? Number(getComputedStyle(particle).opacity) : 0, scrollY };
}, playerId);
const checkEndpoints = endpoints => {
  assert.ok(endpoints.avatar && endpoints.target, 'Flight endpoints exist');
  assert.ok(Math.hypot(endpoints.sourceX - endpoints.avatar.x, endpoints.sourceY - endpoints.avatar.y) < 2, 'Particles start at the correct player avatar');
  assert.ok(Math.hypot(endpoints.targetX - endpoints.target.x, endpoints.targetY - endpoints.target.y) < 2, 'Particles end at the incoming material slot');
};
try {
  await mkdir('artifacts', { recursive: true });
  for (const [size, viewport] of sizes) {
    const reduced = size === 'reduced-mobile';
    let products = 0, rollIndex = 0;
    const rolls = [1, 1, 1, 0, 0]; // Preserve turn order; third deposit triggers two consecutive reactions.
    const names = ['暖风藏起的茶匙', '月亮晒过的纽扣', '会轻轻唱歌的羽毛'];
    const provider = {
      ready: true, mode: 'test',
      async price(name) { return { name, price: names.includes(name) ? [100, 200, 300][names.indexOf(name)] : name === '灯芯里的小雨燕' ? 650 : 900, source: 'local-test' }; },
      async synthesize() { return { name: ++products === 1 ? '灯芯里的小雨燕' : '装着晴天的口袋', source: 'local-test' }; },
    };
    const expectedHolds = [1500, 1500, 1000, 1000, 1500];
    const room = new GameRoom({ id: `ANIM${size === 'mobile' ? '02' : '01'}`, provider, depositMs: 1800, reactionMs: 2400, holdMs: 1500, chainHoldMs: 1000, random: () => rolls[rollIndex++] ?? 0, priceRandom: () => 0.99 });
    const players = ['晨露女巫', '月桂女巫', '凤凰女巫'].map(name => room.addPlayer(name));
    const viewer = players[0].id, identity = { roomId: room.id, playerId: viewer, token: 'local-animation-test' };
    const page = await browser.newPage({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await seedInvite(page, { mock: true });
    const samples = [], frames = new Map(), frameEnds = new Map(), phases = [], holdMeasurements = [];
    let stopped = false, monitor, currentFrameId;
    const capture = () => {
      if (phases.at(-1) !== room.phase) phases.push(room.phase);
      if (currentFrameId && currentFrameId !== room.presentation?.id) frameEnds.set(currentFrameId, Date.now());
      currentFrameId = room.presentation?.id;
      if (room.presentation) frames.set(room.presentation.id, structuredClone(room.presentation));
    };
    room.on('change', capture);
    page.on('pageerror', error => report.errors.push(`${size}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`${size}: ${message.text()}`); else if (message.type() === 'warning') report.consoleWarnings.push(`${size}: ${message.text()}`); });
    try {
      await page.route('**/api/health', route => route.fulfill({ json: { ok: true, aiReady: true } }));
      await page.addInitScript(value => sessionStorage.setItem('witchy-session', JSON.stringify(value)), identity);
      await page.routeWebSocket('**/ws', socket => {
        const send = value => socket.send(JSON.stringify(value));
        const update = () => send({ type: 'state', state: room.view(viewer) });
        room.on('change', update);
        socket.onClose(() => room.off('change', update));
        socket.onMessage(async raw => {
          const message = JSON.parse(String(raw));
          if (message.type === 'resume') { send({ type: 'session', ...identity }); update(); send({ type: 'ack', requestId: message.requestId }); }
          else if (message.type === 'action') {
            try { const { action, ...payload } = message.payload; await room.action(viewer, action, payload); send({ type: 'ack', requestId: message.requestId }); }
            catch (error) { send({ type: 'error', requestId: message.requestId, message: error.message }); }
          } else send({ type: 'error', requestId: message.requestId, code: 'CHAT_DISABLED', message: '房间聊天已关闭。' });
        });
      });
      await page.goto(baseURL);
      await expect(page.locator('.room-lobby')).toBeVisible(); await absentChat(page);
      await room.action(viewer, 'start');
      await expect(page.locator('.turn-overlay')).toBeVisible(); await absentChat(page);
      await Promise.all(players.map((player, index) => quoteAndReady(room, player, names[index])));
      await expect(page.locator('.public-card,.public-materials,.round-stirring')).toHaveCount(0);
      monitor = (async () => {
        while (!stopped) {
          try { samples.push(await sample(page)); } catch (error) { if (!/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) throw error; }
          await delay(45);
        }
      })();
      let refreshProgress, holdRefresh, scrolledNarrowFlight = false;
      for (let index = 0; index < 5; index++) {
        await until(() => room.phase === 'performing' && room.presentation?.index === index, `server frame ${index}`);
        const frame = structuredClone(room.presentation), board = page.locator('.presentation-board');
        await expect(board).toHaveAttribute('data-presentation-id', frame.id);
        await expect(board).toHaveAttribute('data-presentation-index', String(index));
        await expect(board).toHaveAttribute('data-presentation-kind', frame.kind);
        await expect(board).toHaveAttribute('data-animation-ms', String(frame.animationMs));
        await expect(board).toHaveAttribute('data-hold-ms', String(frame.holdMs));
        assert.equal(frame.holdMs, expectedHolds[index]); assert.equal(frame.durationMs, frame.animationMs + frame.holdMs);
        assert.equal(frame.total, 5); assert.equal(room.roundResult, null);
        assert.equal(room.view(viewer).me.coins, 19900);
        await expect(page.locator('.coin-rank-row')).toHaveCount(0); await absentChat(page);
        await until(async () => (await sample(page)).motionProgress >= (!reduced && index === 0 ? 0.06 : 0.15), `frame ${index} begins visibly`);
        if (reduced) {
          await expect(board).toHaveAttribute('data-reduced-motion', 'true');
          await expect(page.locator('.presentation-flight-particle')).toHaveCount(0);
          await expect(page.locator('.presentation-reserved-slot')).toHaveCount(0);
          assert.deepEqual(await page.locator('.presentation-card').evaluateAll(nodes => nodes.map(node => node.dataset.materialId)), frame.potAfter.map(card => card.id));
          for (const card of frame.potAfter) await expect(page.locator(`.presentation-card[data-material-id="${card.id}"]`)).toBeVisible();
          if (index === 2 || index === 4) await page.screenshot({ path: `artifacts/animation-reduced-${index === 2 ? 'materials' : 'product'}-mobile.png`, fullPage: true });
        } else if (frame.kind === 'deposit') {
          await expect(page.locator('.presentation-reserved-slot')).toHaveCount(1);
          assert.ok((await sample(page)).visibleParticles > 0, 'Each deposit emits visible light particles');
          const endpoints = await inspectFlight(page, frame.playerId); checkEndpoints(endpoints);
          if (index === 0) {
            assert.ok(endpoints.opacity > .05 && endpoints.particle, 'Leading particle is painted');
            assert.ok(Math.hypot(endpoints.particle.x - endpoints.avatar.x, endpoints.particle.y - endpoints.avatar.y) < 55, 'The painted particle begins near its avatar');
            const before = await sample(page);
            room.emit('change'); await delay(80);
            const after = await sample(page);
            assert.equal(after.id, before.id); assert.ok(after.elapsed >= before.elapsed + 30, 'Same-frame state must not restart progress');
            await until(async () => (await sample(page)).motionProgress >= .32, 'light crosses toward the cauldron');
            await page.screenshot({ path: `artifacts/animation-flight-${size}.png`, fullPage: true });
            await until(async () => (await sample(page)).motionProgress >= .70, 'light reaches the material slot');
            const arrived = await inspectFlight(page, frame.playerId); checkEndpoints(arrived);
            assert.ok(arrived.opacity > .05 && arrived.particle, 'Arriving particle is painted');
            assert.ok(Math.hypot(arrived.particle.x - arrived.target.x, arrived.particle.y - arrived.target.y) < 30, 'The painted particle reaches its actual material slot');
          }
          if (index === 1 && size === 'mobile') {
            await page.setViewportSize({ width: 320, height: 700 });
            await page.evaluate(() => window.scrollTo(0, Math.min(150, document.documentElement.scrollHeight - innerHeight)));
            await delay(35);
            const moved = await inspectFlight(page, frame.playerId); checkEndpoints(moved);
            assert.ok(moved.scrollY > 0, 'Mobile flight tested after real scrolling');
            assert.ok((await sample(page)).visibleParticles > 0);
            await page.screenshot({ path: 'artifacts/animation-flight-scrolled-narrow.png', fullPage: true });
            assert.equal((await sample(page)).overflow, false, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].map(node => ({ tag: node.tagName, className: String(node.className), left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })).filter(node => node.right > innerWidth + 1 || node.left < -1).slice(0, 20))));
            await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, 0));
            scrolledNarrowFlight = true;
          }
          await until(async () => (await sample(page)).motionProgress >= 0.84, `deposit ${index} becomes a card`);
          const material = page.locator(`.presentation-card[data-material-id="${frame.material.id}"]`);
          await expect(material).toBeVisible(); await expect(material).toContainText(frame.material.name);
        } else {
          await expect(page.locator('.presentation-reactant')).toHaveCount(2);
          assert.equal(frame.ingredients.length, 2);
          if (index === 3) {
            const before = await sample(page), startedAt = frame.startedAt;
            await page.reload();
            await expect(page.locator('.presentation-board')).toHaveAttribute('data-presentation-id', frame.id);
            const after = await sample(page);
            assert.equal(room.presentation.startedAt, startedAt);
            assert.ok(after.elapsed >= before.elapsed, 'Refresh resumes elapsed server time');
            assert.ok(after.elapsed >= 250, 'Refresh must not begin a fresh animation');
            assert.equal(room.view(viewer).me.coins, 19900);
            assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('witchy-session'))), identity);
            refreshProgress = { before: before.motionProgress, after: after.motionProgress, sameFrame: true };
          }
          await until(async () => (await sample(page)).motionProgress >= 0.32, `reaction ${index} fusion`);
          await expect(page.locator('.presentation-reactant[data-stage="dissolving"]')).toHaveCount(2);
          if (index === 3) await page.screenshot({ path: `artifacts/animation-fusion-${size}.png`, fullPage: true });
          await until(async () => (await sample(page)).motionProgress >= 0.8, `reaction ${index} product`);
          const product = page.locator('.presentation-product[data-visible="true"]');
          await expect(product).toBeVisible(); await expect(product).toContainText(frame.product.name);
        }
        if (!reduced) {
          await until(async () => (await sample(page)).motionProgress >= .9, `frame ${index} still animates near its end`);
          const target = page.locator(`.presentation-card[data-material-id="${frame.kind === 'deposit' ? frame.material.id : frame.product.id}"]`);
          const style = await target.evaluate(node => { const value = getComputedStyle(node); return { opacity: Number(value.opacity), filter: value.filter, transform: value.transform }; });
          assert.ok(style.opacity < .999 || !['none', 'blur(0px)'].includes(style.filter) || !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(style.transform), 'Visual motion continues through the declared animation interval');
        }
        await until(async () => (await sample(page)).holding, `frame ${index} enters reading hold`);
        await expect(page.locator('.presentation-flight-particle')).toHaveCount(0);
        assert.equal((await sample(page)).motionProgress, 1);
        if (!reduced && index === 2) await page.screenshot({ path: `artifacts/animation-three-cards-${size}.png`, fullPage: true });
        if (!reduced && frame.kind === 'reaction') await page.screenshot({ path: `artifacts/animation-product-${index - 2}-${size}.png`, fullPage: true });
        if (index === 3) {
          await delay(Math.min(250, frame.holdMs / 5));
          const before = await sample(page);
          await page.reload();
          await expect(page.locator('.presentation-board')).toHaveAttribute('data-presentation-id', frame.id);
          await expect(page.locator('.presentation-board')).toHaveAttribute('data-holding', 'true');
          await expect(page.locator('.presentation-flight-particle')).toHaveCount(0);
          const after = await sample(page);
          assert.equal(room.presentation.startedAt, frame.startedAt);
          assert.ok(after.elapsed >= before.elapsed); assert.equal(after.motionProgress, 1);
          assert.equal(room.roundResult, null);
          holdRefresh = { index, holdMs: frame.holdMs, beforeMs: before.elapsed, afterMs: after.elapsed, sameFrame: true, noParticleReplay: true };
          await page.screenshot({ path: `artifacts/animation-reading-hold-${size}.png`, fullPage: true });
        }
        await until(() => room.presentation?.id !== frame.id, `frame ${index} full reading hold ends`);
        const measuredHoldMs = frameEnds.get(frame.id) - frame.startedAt - frame.animationMs;
        assert.ok(measuredHoldMs >= frame.holdMs - 5, `Frame ${index} actually held for ${measuredHoldMs} ms; expected ${frame.holdMs} ms`);
        const readings = samples.filter(item => item.id === frame.id && item.holding);
        assert.ok(readings.length >= Math.floor(frame.holdMs / 100), 'Reading hold is observed continuously, not as a single snapshot');
        assert.ok(readings.at(-1).at - readings[0].at >= frame.holdMs - 200, `Browser remains readable for approximately ${frame.holdMs} ms`);
        const baseline = readings[0].cards;
        for (const reading of readings) {
          assert.equal(reading.particles, 0); assert.equal(reading.ranks, 0);
          assert.deepEqual(reading.cards.map(card => card.id), frame.potAfter.map(card => card.id));
          for (const [cardIndex, card] of reading.cards.entries()) {
            assert.equal(card.opacity, '1'); assert.ok(['none', 'blur(0px)'].includes(card.filter));
            assert.ok(['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(card.transform));
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(card[key] - baseline[cardIndex][key]) < .75, `Hold card ${card.id} ${key} must stay still`);
          }
        }
        holdMeasurements.push({ index, kind: frame.kind, expectedHoldMs: frame.holdMs, measuredHoldMs, readableSamples: readings.length });
      }
      await until(() => room.phase === 'roundEnd', 'ranking after all frames');
      await expect(page.locator('.winner-celebration')).toHaveAttribute('data-celebration-id', room.roundResult.winnerCelebration.id);
      await expect(page.locator('.presentation-board')).toHaveAttribute('data-presentation-id', room.roundResult.winnerCelebration.backdrop.id);
      await expect(page.locator('.winner-material-price')).toHaveAttribute('data-price', '300');
      await expect(page.locator('.coin-rank-row')).toHaveCount(0);
      await page.locator('.winner-continue').click();
      await expect(page.locator('.winner-celebration')).toHaveCount(0);
      await expect(page.locator('.presentation-board')).toHaveCount(0);
      await expect(page.locator('.coin-rank-row')).toHaveCount(3); await absentChat(page);
      await page.screenshot({ path: `artifacts/animation-ranking-${size}.png`, fullPage: true });
      stopped = true; await monitor;
      assert.equal(products, 2); assert.equal(room.pot[0].name, '装着晴天的口袋'); assert.equal(room.pot[0].price, 900);
      const timeline = [...frames.values()];
      assert.deepEqual(timeline.map(frame => frame.kind), ['deposit', 'deposit', 'deposit', 'reaction', 'reaction']);
      assert.deepEqual(timeline.map(frame => frame.holdMs), expectedHolds);
      assert.ok(timeline[4].ingredients.some(card => card.id === timeline[3].product.id), 'The first product is consumed by the next reaction');
      assert.deepEqual(phases, ['preparing', 'resolving', 'performing', 'roundEnd']);
      if (reduced) assert.ok(samples.every(item => item.particles === 0), 'Reduced motion never emits particles');
      else { assert.ok(samples.some(item => item.visibleParticles > 0 && item.reserved > 0)); assert.ok(samples.some(item => item.reactants === 2)); }
      assert.ok(samples.some(item => item.product === 'true'));
      assert.ok(samples.every(item => !item.overflow), `${size}: no horizontal overflow during animation`);
      assert.ok(samples.every(item => item.publicCards === 0), 'No simultaneous public-card or fixed stirring screen is shown');
      assert.ok(samples.filter(item => item.id).every(item => item.ranks === 0), 'Ranking cannot appear before the performance ends');
      report.checks.push({ size, viewport, reducedMotion: reduced, deposits: 3, consecutiveReactions: 2, sourceLightParticles: !reduced, paintedParticlesReachActualEndpoints: !reduced, scrolledNarrowFlight, twoReactantsFuse: !reduced, bothProductsAppear: true, sameFrameBroadcastPreservesProgress: !reduced, refreshProgress, holdRefresh, holdMeasurements, fullyOpaqueSharpStationaryDuringHold: true, noRevealStage: true, noChatUI: true, rankingAfterFinalHold: true, winnerConfirmationBeforeRanking: true, originalWinnerPriceShown: true, goldChargedOnce: true, noHorizontalOverflow: true, frames: timeline.map(({ id, index, kind, startedAt, animationMs, holdMs, durationMs }) => ({ id, index, kind, startedAt, animationMs, holdMs, durationMs })) });
    } finally { stopped = true; await monitor?.catch(() => {}); room.dispose(); await page.close(); }
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
  await writeFile('artifacts/animation-qa.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
