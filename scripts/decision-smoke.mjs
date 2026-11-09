import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { GameRoom } from '../server/game.js';
import { FixtureAlchemyProvider } from '../tests/helpers/fixture-alchemy.js';
import { prepareLap } from '../tests/helpers/game-fixture.js';
import { seedInvite } from './helpers/invite-fixture.mjs';

// A real engine drives both browsers. Longer fixture deadlines leave enough time
// for screenshots; production continues to use the configured ten seconds.
const room = new GameRoom({ id: 'DECIDE', provider: new FixtureAlchemyProvider(), animationMs: 1, decisionMs: 30000, revealMs: 0, random: () => 1 });
const players = ['月光女巫', '薄荷女巫'].map(name => room.addPlayer(name));
const requests = [], errors = [];
let queue = Promise.resolve();
async function finishLap() {
  await prepareLap(room, room.players.filter(player => player.status === 'active').map(player => ({ player, name: '晨露' })));
  assert.equal(room.phase, 'decision');
}
await room.action(players[0].id, 'start');
await finishLap();
assert.deepEqual(players.map(player => player.coins), [19995, 19995]);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const pages = [
    await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }),
  ];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], viewer = players[index].id;
    await seedInvite(page, { mock: true });
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/ws', socket => {
      const update = () => socket.send(JSON.stringify({ type: 'state', state: room.view(viewer) }));
      room.on('change', update);
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        queue = queue.then(async () => {
          try {
            assert.equal(message.type, 'action');
            requests.push({ viewer, ...message.payload });
            await room.action(viewer, message.payload.action, message.payload);
            socket.send(JSON.stringify({ type: 'ack', requestId: message.requestId }));
          } catch (error) {
            socket.send(JSON.stringify({ type: 'error', requestId: message.requestId, message: error.message }));
          }
        });
      });
      update();
    });
    await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:3001');
  }
  const [host, phone] = pages;
  const dialogs = pages.map(page => page.getByRole('dialog', { name: '还想再添一份灵感吗？', exact: true }));
  for (let index = 0; index < pages.length; index++) {
    await dialogs[index].waitFor();
    assert.equal(await dialogs[index].getAttribute('aria-modal'), 'true');
    assert.equal(await pages[index].locator('.decision-overlay').count(), 1);
    assert.equal(await pages[index].evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Decision view must not overflow horizontally');
    assert.equal(await dialogs[index].evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1;
    }), true, 'The entire decision dialog fits its viewport');
    await pages[index].waitForFunction(() => Number(getComputedStyle(document.querySelector('.decision-overlay')).opacity) >= .99);
    await pages[index].screenshot({ path: `artifacts/dark-decision-${index ? 'mobile' : 'desktop'}.png`, fullPage: true });
  }

  const focusable = dialogs[0].locator('button:not([disabled])');
  await focusable.last().focus();
  await host.keyboard.press('Tab');
  assert.equal(await focusable.first().evaluate(node => node === document.activeElement), true, 'Tab wraps to the first dialog action');
  await host.keyboard.press('Shift+Tab');
  assert.equal(await focusable.last().evaluate(node => node === document.activeElement), true, 'Shift+Tab stays inside the decision dialog');

  await dialogs[0].getByRole('button', { name: '确认我的决定', exact: true }).click();
  await dialogs[0].getByRole('button', { name: '取消确认', exact: true }).waitFor();
  assert.equal(players[0].decision.confirmed, true);
  assert.equal(room.phase, 'decision', 'One confirmation cannot resolve everyone’s choices');
  await dialogs[0].getByRole('button', { name: '取消确认', exact: true }).click();
  await dialogs[0].getByRole('button', { name: '确认我的决定', exact: true }).waitFor();
  assert.equal(players[0].decision.confirmed, false);
  await dialogs[0].getByRole('button', { name: /这轮先到这里/ }).click();
  await dialogs[0].locator('.leave-choice.selected').waitFor();
  assert.equal(players[0].decision.stay, false);
  await dialogs[0].getByRole('button', { name: /继续参与/ }).click();
  await dialogs[0].locator('.tea-choice.selected:not(.leave-choice)').waitFor();
  for (const dialog of dialogs) await dialog.getByRole('button', { name: '确认我的决定', exact: true }).click();
  await dialogs[0].waitFor({ state: 'hidden' });
  await dialogs[1].waitFor({ state: 'hidden' });
  assert.equal(room.phase, 'preparing');
  for (const page of pages) await page.locator('.turn-overlay').waitFor();
  assert.equal(room.lap, 2);

  // The next complete lap must reopen the floating decision automatically.
  await finishLap();
  assert.deepEqual(players.map(player => player.coins), [19990, 19990]);
  for (const dialog of dialogs) await dialog.waitFor();
  await dialogs[0].getByRole('button', { name: /这轮先到这里/ }).click();
  await dialogs[0].getByRole('button', { name: '确认我的决定', exact: true }).click();
  await dialogs[1].getByRole('button', { name: '确认我的决定', exact: true }).tap();
  await host.getByRole('tab', { name: '历史记录', exact: true }).waitFor();
  assert.equal(room.phase, 'roundEnd');
  assert.equal(room.roundResult.winnerId, players[1].id);
  assert.equal(room.roundResult.reason, 'last-standing');
  assert.deepEqual(players.map(player => player.coins), [19990, 20010], 'Settlement retains spent mana and only adds potion mana to the winner');
  for (const page of pages) {
    await page.getByRole('tab', { name: '历史记录', exact: true }).click();
    assert.equal(await page.locator('.results-history-heading').count(), 0, 'The removed history banner must not be rendered');
    assert.equal(await page.getByText('把这一锅的故事，翻出来看看。', { exact: true }).count(), 0);
    assert.equal(await page.locator('.results-event-deposit').count(), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.ok(requests.some(request => request.action === 'decision' && request.confirmed === false));
  assert.ok(requests.some(request => request.action === 'decision' && request.confirmed === true));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, clients: 2, decisionLaps: 2, confirmCancellation: true, authoritativeSubmission: true, automaticModal: true, historyBannerRemoved: true, mobileWidth: 390, pageErrors: 0 }));
} finally { room.dispose(); await browser.close(); }
