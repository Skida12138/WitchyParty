import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { GameRoom } from '../server/game.js';
import { quoteAndReady } from '../tests/helpers/game-fixture.js';
import { seedInvite } from './helpers/invite-fixture.mjs';

// A real local GameRoom supplies every frame and settlement. Its provider is an
// in-memory test double, and browser WebSockets never reach a production room.
const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const requested = process.env.WINNER_SCENARIOS?.split(',');
const scenarios = [
  ['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }],
  ['narrow', { width: 320, height: 700 }], ['reduced-mobile', { width: 390, height: 844 }],
].filter(([name]) => !requested || requested.includes(name));
assert.ok(scenarios.length, 'At least one winner scenario must be selected');
const report = { ok: false, baseURL, realModelCalls: 0, deterministicGameRoom: true, checks: [], errors: [], consoleErrors: [], consoleWarnings: [] };
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
async function until(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await delay(10); }
}
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
const samples = page => page.evaluate(() => window.__winnerSamples);
async function centerCheck(page, viewport, label) {
  const bounds = await page.locator('.winner-flight-avatar').boundingBox();
  assert.ok(bounds, `${label}: winning avatar is visible`);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 2, `${label}: avatar centered horizontally`);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2, `${label}: avatar centered vertically`);
  return bounds;
}
try {
  assert.equal((await fetch(baseURL)).ok, true);
  await mkdir('artifacts', { recursive: true });
  for (const [size, viewport] of scenarios) {
    const reduced = size === 'reduced-mobile';
    const materialName = '一只收藏着星光与雨声并且每天清晨都会悄悄唱歌的玻璃蝴蝶';
    const names = ['暖风藏起的茶匙', '月亮晒过的纽扣', materialName];
    const prices = { [names[0]]: 100, [names[1]]: 200, [names[2]]: 12000, '第二轮的星光风铃': 400, '第二轮的花影': 50 };
    const provider = { ready: true, mode: 'test', async price(name) { return { name, price: prices[name], source: 'local-test' }; }, async synthesize() { throw new Error('This winner fixture must not synthesize'); } };
    const room = new GameRoom({ id: `WIN${size.toUpperCase().replace('-', '')}`, provider, rounds: 3, depositMs: 300, reactionMs: 300, holdMs: 500, chainHoldMs: 250, random: () => 1 });
    const players = ['晨露冠军女巫', '月桂女巫', '月光森林里的星河长名字女巫'].map(name => room.addPlayer(name));
    // A deliberate score gap makes the final round winner different from the
    // match champion, so the celebration cannot accidentally use final ranking.
    players[0].coins = 50000;
    const viewer = players[0].id, identity = { roomId: room.id, playerId: viewer, token: 'local-winner-test' };
    const page = await browser.newPage({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await seedInvite(page, { mock: true });
    page.on('pageerror', error => report.errors.push(`${size}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`${size}: ${message.text()}`); else if (message.type() === 'warning') report.consoleWarnings.push(`${size}: ${message.text()}`); });
    try {
      await page.route('**/api/health', route => route.fulfill({ json: { ok: true, aiReady: true } }));
      await page.addInitScript(value => {
        sessionStorage.setItem('witchy-session', JSON.stringify(value));
        window.__winnerSamples = [];
        const sample = () => {
          const root = document.querySelector('.winner-celebration'), avatar = document.querySelector('.winner-flight-avatar');
          if (root && avatar) {
            const box = avatar.getBoundingClientRect();
            window.__winnerSamples.push({ at: Date.now(), id: root.dataset.celebrationId, winnerId: root.dataset.winnerId, progress: Number(root.dataset.progress), elapsed: Number(root.dataset.elapsedMs), x: box.x, y: box.y, width: box.width, height: box.height, sourceX: Number(avatar.dataset.sourceX), sourceY: Number(avatar.dataset.sourceY), sourceSize: Number(avatar.dataset.sourceSize), targetX: Number(avatar.dataset.targetX), targetY: Number(avatar.dataset.targetY), targetSize: Number(avatar.dataset.targetSize), ranks: document.querySelectorAll('.coin-rank-row').length });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, identity);
      await page.routeWebSocket('**/ws', socket => {
        const send = value => socket.send(JSON.stringify(value));
        const update = () => send({ type: 'state', state: room.view(viewer) });
        room.on('change', update); socket.onClose(() => room.off('change', update));
        socket.onMessage(async raw => {
          const message = JSON.parse(String(raw));
          if (message.type === 'resume') { send({ type: 'session', ...identity }); update(); send({ type: 'ack', requestId: message.requestId }); }
          else if (message.type === 'action') {
            try { const { action, ...payload } = message.payload; await room.action(viewer, action, payload); send({ type: 'ack', requestId: message.requestId }); }
            catch (error) { send({ type: 'error', requestId: message.requestId, message: error.message }); }
          } else send({ type: 'error', requestId: message.requestId, message: 'Only local fixture actions are supported' });
        });
      });
      await page.goto(baseURL); await expect(page.locator('.room-lobby')).toBeVisible();
      await room.action(viewer, 'start');
      await room.action(viewer, 'quote', { name: materialName });
      await expect(page.locator('.quality-card.tier-red')).toBeVisible();
      const redAura = await page.locator('.quality-card.tier-red .ruby-aura').evaluate(node => {
        const style = getComputedStyle(node), before = getComputedStyle(node, '::before');
        return { inset: parseFloat(style.top), blur: style.filter, ringPadding: parseFloat(before.paddingTop), bounds: { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height } };
      });
      assert.ok(Math.abs(redAura.inset) < (viewport.width <= 700 ? 7 : 9), `${size}: red card glow has a smaller radius`);
      await page.screenshot({ path: `artifacts/winner-red-card-${size}.png`, fullPage: true });
      await Promise.all(players.map((player, index) => quoteAndReady(room, player, names[index])));
      await expect(page.locator('.presentation-board')).toBeVisible();
      if (size === 'mobile' || size === 'narrow') {
        await page.evaluate(() => window.scrollTo(0, Math.min(200, document.documentElement.scrollHeight - innerHeight)));
        assert.ok(await page.evaluate(() => scrollY > 0), `${size}: actual scrolled layout is exercised`);
      }
      await until(() => room.presentation?.index === 2, `${size} final deposit`);
      await expect(page.locator('.presentation-board')).toHaveAttribute('data-holding', 'true');
      const source = await page.locator(`[data-player-id="${players[2].id}"] .circle-avatar .avatar`).boundingBox();
      assert.ok(source);
      await page.screenshot({ path: `artifacts/winner-final-material-${size}.png`, fullPage: true });
      await until(() => room.phase === 'roundEnd', `${size} round settlement`);
      const result = room.roundResult, celebration = result.winnerCelebration, overlay = page.locator('.winner-celebration');
      assert.equal(celebration.winner.id, result.winnerId); assert.equal(result.winnerId, players[2].id);
      assert.equal(celebration.material.price, 12000); assert.equal(result.potValue, 12300); assert.notEqual(celebration.material.price, result.potValue);
      await expect(overlay).toHaveAttribute('data-celebration-id', celebration.id);
      await expect(overlay).toHaveAttribute('data-winner-id', players[2].id);
      await expect(page.locator('.winner-name')).toHaveText(players[2].name);
      await expect(page.locator('.winner-material-name')).toHaveText(materialName);
      await expect(page.locator('.winner-material-price')).toHaveAttribute('data-price', '12000');
      await expect(page.locator('.coin-rank-row')).toHaveCount(0);
      await expect(page.locator('.presentation-board')).toHaveAttribute('data-presentation-id', celebration.backdrop.id);
      await expect(page.locator('.app-shell')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('.app-shell[inert]')).toHaveCount(1);
      const frosted = await overlay.evaluate(node => [node, ...node.querySelectorAll('*')].map(item => getComputedStyle(item).backdropFilter).find(value => /blur\([1-9]/.test(value)));
      assert.ok(frosted, `${size}: the full-screen overlay uses frosted glass`);
      let beforeReloadSamples = [], refresh;
      if (!reduced) {
        await until(async () => (await samples(page)).some(item => item.progress >= .25), `${size} avatar moves toward center`);
        await page.screenshot({ path: `artifacts/winner-flight-${size}.png` });
      }
      if (size === 'mobile') {
        beforeReloadSamples = await samples(page);
        const before = beforeReloadSamples.at(-1);
        await page.reload();
        await expect(overlay).toHaveAttribute('data-celebration-id', celebration.id);
        await until(async () => (await samples(page)).length > 0, 'refreshed celebration sample');
        const after = (await samples(page))[0];
        assert.ok(after.elapsed >= before.elapsed, 'An unconfirmed refresh resumes the same animation clock');
        refresh = { beforeMs: before.elapsed, afterMs: after.elapsed, sameId: true };
      }
      await delay(celebration.animationMs + 700);
      await expect(overlay).toBeVisible(); await expect(page.locator('.coin-rank-row')).toHaveCount(0);
      const finalAvatar = await centerCheck(page, viewport, size);
      const path = [...beforeReloadSamples, ...await samples(page)].filter(item => item.id === celebration.id);
      assert.ok(path.length > 5); assert.ok(path.every(item => item.ranks === 0));
      assert.ok(Math.abs(path[0].sourceX - source.x - source.width / 2) < 3, `${size}: flight starts at the winner's seat x`);
      assert.ok(Math.abs(path[0].sourceY - source.y - source.height / 2) < 3, `${size}: flight starts at the winner's seat y`);
      assert.ok(finalAvatar.width > source.width * 2, `${size}: winner avatar grows noticeably`);
      if (!reduced) {
        assert.ok(path.some(item => item.progress > .02 && item.progress < .8), `${size}: intermediate movement is visible`);
        assert.ok(path.some(item => item.width < finalAvatar.width * .8), `${size}: avatar visibly grows along the path`);
      } else {
        await expect(overlay).toHaveAttribute('data-reduced-motion', 'true');
        assert.ok(path.every(item => Math.abs(item.x + item.width / 2 - viewport.width / 2) < 2 && Math.abs(item.y + item.height / 2 - viewport.height / 2) < 2), 'Reduced motion keeps the avatar at its final position');
      }
      const settledLayout = await overlay.evaluate(node => {
        const bounds = item => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right }; };
        return { overlay: bounds(node), name: bounds(node.querySelector('.winner-name')), material: bounds(node.querySelector('.winner-material-name')), price: bounds(node.querySelector('.winner-material-price')), button: bounds(node.querySelector('.winner-continue')) };
      });
      assert.ok(Math.abs(settledLayout.overlay.width - viewport.width) < 2 && Math.abs(settledLayout.overlay.height - viewport.height) < 2, 'Celebration covers the viewport');
      for (const [name, box] of Object.entries(settledLayout).filter(([name]) => name !== 'overlay')) {
        assert.ok(box.x >= 0 && box.right <= viewport.width + 1 && box.y >= 0, `${size}: ${name} is not clipped horizontally`);
      }
      const goldAura = await page.locator('.winner-gold-aura').evaluate(node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { width: box.width, height: box.height, background: style.backgroundImage, filter: style.filter };
      });
      assert.ok(goldAura.width > finalAvatar.width * 2.5, `${size}: golden light spreads well beyond the avatar`);
      assert.match(goldAura.background, /radial-gradient/);
      await noOverflow(page, `${size} winner`);
      await page.screenshot({ path: `artifacts/winner-settled-${size}.png` });
      let scrolledOverlay = null;
      const canScroll = await overlay.evaluate(node => node.scrollHeight > node.clientHeight + 1);
      if (canScroll) {
        await overlay.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await delay(100);
        scrolledOverlay = await page.evaluate(() => {
          const root = document.querySelector('.winner-celebration'), target = document.querySelector('.winner-avatar-target').getBoundingClientRect(), avatar = document.querySelector('.winner-flight-avatar').getBoundingClientRect(), button = document.querySelector('.winner-continue').getBoundingClientRect();
          return { scrollTop: root.scrollTop, targetX: target.x + target.width / 2, targetY: target.y + target.height / 2, avatarX: avatar.x + avatar.width / 2, avatarY: avatar.y + avatar.height / 2, buttonTop: button.top, buttonBottom: button.bottom };
        });
        assert.ok(scrolledOverlay.scrollTop > 0, `${size}: long content can be scrolled`);
        assert.ok(Math.abs(scrolledOverlay.targetX - scrolledOverlay.avatarX) < 2 && Math.abs(scrolledOverlay.targetY - scrolledOverlay.avatarY) < 2, `${size}: scrolled avatar stays aligned with its target without a double offset`);
        assert.ok(scrolledOverlay.buttonTop >= 0 && scrolledOverlay.buttonBottom <= viewport.height, `${size}: the confirmation button remains reachable after scrolling`);
        await page.screenshot({ path: `artifacts/winner-scrolled-${size}.png` });
        await overlay.evaluate(node => { node.scrollTop = 0; }); await delay(80);
        await centerCheck(page, viewport, `${size} restored overlay scroll`);
      }
      if (size !== 'mobile') {
        await page.reload();
        await expect(overlay).toHaveAttribute('data-celebration-id', celebration.id);
        await centerCheck(page, viewport, `${size} unconfirmed refresh`);
        await expect(page.locator('.coin-rank-row')).toHaveCount(0);
      }
      await page.locator('.winner-continue').click();
      await expect(overlay).toHaveCount(0); await expect(page.locator('.coin-rank-row')).toHaveCount(3);
      await page.reload();
      await expect(page.locator('.coin-rank-row')).toHaveCount(3); await expect(overlay).toHaveCount(0);
      let finalRoundDiffersFromChampion = false, independentRounds = false;
      if (size === 'desktop') {
        let previousId = celebration.id;
        for (let round = 2; round <= 3; round++) {
          await page.getByRole('button', { name: `开始第 ${round} 轮出牌`, exact: true }).click();
          await until(() => room.phase === 'preparing' && room.round === round, `round ${round} starts`);
          const chosen = round === 2 ? [names[0], '第二轮的星光风铃', '第二轮的花影'] : names;
          await Promise.all(players.map((player, index) => quoteAndReady(room, player, chosen[index])));
          await until(() => room.roundResult?.round === round, `round ${round} settles`);
          const next = room.roundResult.winnerCelebration;
          assert.notEqual(next.id, previousId); previousId = next.id;
          await expect(overlay).toHaveAttribute('data-celebration-id', next.id);
          await expect(overlay).toHaveAttribute('data-winner-id', round === 2 ? players[1].id : players[2].id);
          await expect(page.locator('.coin-rank-row')).toHaveCount(0);
          if (round === 3) {
            assert.equal(room.phase, 'finished'); assert.equal(room.matchWinnerId, players[0].id);
            assert.notEqual(next.winner.id, room.matchWinnerId); finalRoundDiffersFromChampion = true;
            await delay(next.animationMs + 100);
            await page.screenshot({ path: 'artifacts/winner-final-round-desktop.png' });
            await page.mouse.click(10, 10);
          } else await page.keyboard.press('Enter');
          await expect(overlay).toHaveCount(0); await expect(page.locator('.coin-rank-row')).toHaveCount(3);
        }
        independentRounds = true;
      }
      await page.screenshot({ path: `artifacts/winner-ranking-${size}.png`, fullPage: true });
      report.checks.push({ size, viewport, reducedMotion: reduced, originalPrice: 12000, potReward: 12300, noAutomaticDismiss: true, confirmedRefreshDoesNotReplay: true, unconfirmedRefreshRestores: true, independentRounds, finalRoundDiffersFromChampion, clickThenRanking: true, source, finalAvatar, redAura, goldAura, frosted, settledLayout, scrolledOverlay, refresh, motionSamples: path.length });
    } finally { room.dispose(); await page.close(); }
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
  await writeFile(`artifacts/winner-qa${requested ? `-${requested.join('-')}` : ''}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
