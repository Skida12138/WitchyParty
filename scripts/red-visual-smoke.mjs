import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { GameRoom } from '../server/game.js';
import { FixtureAlchemyProvider } from '../tests/helpers/fixture-alchemy.js';
import { quoteAndReady, waitUntil } from '../tests/helpers/game-fixture.js';
import { seedInvite } from './helpers/invite-fixture.mjs';

const room = new GameRoom({ provider: new FixtureAlchemyProvider(), animationMs: 1, random: () => 1 });
const players = ['星光女巫', '薄荷女巫', '晨露女巫'].map(name => room.addPlayer(name));
await room.action(players[0].id, 'start');
await room.action(players[0].id, 'quote', { name: '一颗迷路的星星' });
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const errors = [];
async function verifyRedCard(locator) {
  await locator.waitFor();
  const details = await locator.evaluate(node => {
    const aura = node.querySelector('.ruby-aura');
    if (!aura) return { missingAura: true };
    const glow = getComputedStyle(aura);
    const radiance = getComputedStyle(aura, '::before');
    return {
      text: node.textContent, titles: [...node.querySelectorAll('[title],[aria-label]')].map(item => `${item.title} ${item.getAttribute('aria-label') || ''}`).join(' '),
      animation: radiance.animationName, duration: radiance.animationDuration, background: radiance.backgroundImage,
      outerFilter: glow.filter, outerMask: glow.maskImage, innerMask: radiance.maskImage,
      mechanismMarkers: node.querySelectorAll('.quality-stable,.material-lock,.lucide-lock-keyhole').length,
    };
  });
  assert.ok(!details.missingAura, 'Red cards must render their separate glow layer');
  assert.ok(!/不会合成|不参与合成|合成概率|概率平方|稳定/.test(details.text + details.titles));
  assert.equal(details.mechanismMarkers, 0);
  assert.match(details.animation, /ruby-radiance-turn/);
  assert.notEqual(details.duration, '0s');
  assert.match(details.background, /conic-gradient/);
  assert.match(details.outerFilter, /blur\(/, 'The outer layer must soften the glow after the inner ring is masked');
  assert.equal(details.outerMask, 'none', 'The glow must remain free to fade beyond the inner ring');
  assert.notEqual(details.innerMask, 'none', 'The rotating conic gradient must retain its ring mask');
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await seedInvite(page, { mock: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/ws', socket => {
    const update = () => {
      const state = room.view(players[0].id);
      assert.ok(!JSON.stringify(state).includes('"locked"'));
      socket.send(JSON.stringify({ type: 'state', state }));
    };
    room.on('change', update); update();
  });
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:3001');
  await verifyRedCard(page.locator('.quality-card.tier-red'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'artifacts/red-quote-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyRedCard(page.locator('.quality-card.tier-red'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'artifacts/red-quote-mobile.png', fullPage: true });

  await room.action(players[0].id, 'commit', { quoteId: players[0].quotes[0].id });
  await Promise.all([quoteAndReady(room, players[1], '月光蘑菇'), quoteAndReady(room, players[2], '晨露')]);
  await waitUntil(() => room.phase === 'decision');
  await room.action(players[0].id, 'decision', { stay: false, confirmed: true });
  await room.action(players[1].id, 'decision', { stay: true, confirmed: true });
  await room.action(players[2].id, 'decision', { stay: true, confirmed: true });
  await page.locator('.material').nth(2).waitFor();
  await page.locator('.decision-overlay').waitFor({ state: 'hidden' });
  const transitionLayout = await page.evaluate(async () => {
    const frames = [];
    for (let frame = 0; frame < 36; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const card = document.querySelector('.material'), heading = document.querySelector('.materials-heading');
      frames.push({ cardTop: card.getBoundingClientRect().top, headingBottom: heading.getBoundingClientRect().bottom });
    }
    return frames;
  });
  assert.ok(transitionLayout.every(frame => frame.cardTop >= frame.headingBottom - 1), `Cards must stay below the heading throughout the preparation transition: ${JSON.stringify(transitionLayout)}`);
  assert.deepEqual(room.pot.map(card => card.price), [12000, 25, 5]);
  const tiers = await page.locator('.material').evaluateAll(cards => cards.map(card => [...card.classList].find(value => value.startsWith('tier-'))));
  assert.deepEqual(tiers, ['tier-red', 'tier-green', 'tier-white']);
  assert.equal(await page.getByText('魔力由高到低', { exact: true }).count(), 1);
  assert.equal(await page.locator('.material-index,.material-lock,.material-locked').count(), 0);
  await verifyRedCard(page.locator('.material.tier-red'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // The preparation/status transition moves the gallery and triggers a 550ms
  // FLIP animation. Check the settled layout, rather than its old coordinates.
  await page.waitForTimeout(800);
  const mobileGeometry = await page.evaluate(() => ({
    galleryScrollTop: document.querySelector('.tea-gallery').scrollTop,
    panel: document.querySelector('.materials-panel').getBoundingClientRect().toJSON(),
    title: document.querySelector('.tea-gallery-title').getBoundingClientRect().toJSON(),
    heading: document.querySelector('.materials-heading').getBoundingClientRect().toJSON(),
    cards: [...document.querySelectorAll('.material')].map(node => ({ rect: node.getBoundingClientRect().toJSON(), transform: getComputedStyle(node).transform })),
  }));
  assert.ok(mobileGeometry.cards[0].rect.top >= mobileGeometry.heading.bottom - 1, `Settled first card must sit below the material heading: ${JSON.stringify(mobileGeometry)}`);
  await page.screenshot({ path: 'artifacts/red-pot-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await verifyRedCard(page.locator('.material.tier-red'));
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.material').first().evaluate(node => node.getBoundingClientRect().top >= document.querySelector('.materials-heading').getBoundingClientRect().bottom - 1), true);
  await page.screenshot({ path: 'artifacts/red-pot-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '查看游戏规则', exact: true }).click();
  const rules = page.getByRole('dialog', { name: '午后集会的小约定', exact: true });
  await rules.waitFor();
  assert.ok(!/不会合成|不参与合成|合成概率|概率平方|概率很低|红色材料/.test(await rules.textContent()));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, descendingPot: true, rotatingRadialGlow: true, hiddenMechanismsNotExposed: true, desktopAndMobile: true, settledMobileGeometry: mobileGeometry, pageErrors: 0 }));
} finally { room.dispose(); await browser.close(); }
