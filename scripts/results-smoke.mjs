import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { GameRoom } from '../server/game.js';
import { prepareLap } from '../tests/helpers/game-fixture.js';
import { seedInvite } from './helpers/invite-fixture.mjs';

// Deterministic engine fixture: eight players, two with negative mana, no reactions.
const names = ['云朵茶匙', '小龙曲奇', '晨曦丝带', '蜂蜜铃铛', '午后影子', '草莓耳语', '花园笑声', '日光书签'];
const prices = [30000, 25000, 80, 120, 350, 800, 2500, 5000];
const room = new GameRoom({ animationMs: 1, random: () => 1, provider: { mode: 'test', ready: true, price: async name => ({ price: prices[names.indexOf(name)], source: 'fixture' }) } });
const players = names.map((_, i) => room.addPlayer(`第${i + 1}位下午茶女巫`));
await room.action(players[0].id, 'start');
await prepareLap(room, players.map((player, index) => ({ player, name: names[index] })));
for (const p of players) if (room.phase === 'decision') await room.action(p.id, 'decision', { stay: false, confirmed: true });
assert.equal(room.roundResult.players[1].balance, -5000);
assert.equal(room.roundResult.players[0].cost, 30000);
assert.equal(room.roundResult.players[0].balance, 53850);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const start = Date.now() - 5000;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await seedInvite(page, { mock: true });
  await page.routeWebSocket('**/ws', socket => {
    const state = room.view(players[0].id);
    state.roundResult.revealStartedAt = start;
    state.serverTime = Date.now();
    socket.send(JSON.stringify({ type: 'state', state }));
  });
  const url = process.env.PREVIEW_URL || 'http://127.0.0.1:3001';
  await page.goto(url);
  await page.locator('.ceremony-card-flipped').first().waitFor();
  assert.ok(await page.locator('.ceremony-card-flipped').count() >= 3, 'Reconnect resumes reveal position');
  assert.equal(await page.getByRole('tab', { name: '排行榜', exact: true }).count(), 0);
  await page.locator('.ceremony-person').first().waitFor();
  assert.equal(await page.locator('.ceremony-cost').count(), 0, 'Settlement must not repeat the mana consumption animation');
  assert.match(await page.locator('.ceremony-person').first().textContent(), /−?[-]?10,000/, 'The winner starts with the mana already remaining after their deposit');
  assert.match(await page.locator('.ceremony-person').nth(1).textContent(), /−?[-]?5,000/);
  await page.locator('.ceremony-person-absorbing').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.ceremony-potion').isVisible(), true);
  await page.getByRole('tab', { name: '历史记录', exact: true }).waitFor({ timeout: 20000 });
  assert.match(await page.locator('.ceremony-person').first().textContent(), /53,850/);
  assert.match(await page.locator('.ceremony-person').nth(1).textContent(), /−?[-]?5,000/);
  await page.screenshot({ path: 'artifacts/dark-eight-player-results.png', fullPage: true });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await seedInvite(phone, { mock: true });
  await phone.routeWebSocket('**/ws', socket => {
    const state = room.view(players[0].id);
    state.roundResult.revealStartedAt = Date.now() - state.roundResult.revealDurationMs - 100;
    state.serverTime = Date.now();
    socket.send(JSON.stringify({ type: 'state', state }));
  });
  await phone.goto(url);
  await phone.getByRole('tab', { name: '历史记录', exact: true }).tap();
  assert.equal(await phone.locator('.results-history-heading').count(), 0, 'History banner was removed');
  assert.equal(await phone.getByText('把这一锅的故事，翻出来看看。', { exact: true }).count(), 0);
  const material = phone.locator('.results-material-name button').first();
  await material.tap();
  await phone.getByRole('tooltip').waitFor();
  assert.match(await phone.getByRole('tooltip').textContent(), /30,000 魔力/);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({ path: 'artifacts/dark-eight-player-history-mobile.png', fullPage: true });
  await material.tap();
  await phone.getByRole('tooltip').waitFor({ state: 'hidden' });
  console.log(JSON.stringify({ ok: true, players: 8, manaAlreadySpent: 30000, potionOnlyAtSettlement: true, winnerBalance: 53850, negativeBalance: -5000, resumeReveal: true, touchTooltip: true }));
} finally { room.dispose(); await browser.close(); }
