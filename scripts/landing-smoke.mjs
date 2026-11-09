import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixture, until } from '../tests/helpers/live-server.js';
import { seedInvite, testInviteHash } from './helpers/invite-fixture.mjs';

// Render the live local frontend and send only create/join/leave traffic to an
// isolated production server with a local model stub. No game or AI is started.
const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const cleanup = [], errors = [], checks = [];
let browser, server;
const report = { ok: false, baseURL, isolatedLocalServer: true, realModelCalls: 0, checks, errors };
const scenarios = [
  ['desktop', { width: 1440, height: 1000 }, 3],
  ['mobile', { width: 390, height: 844 }, 5],
  ['narrow', { width: 320, height: 700 }, 10],
];
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
}
async function landing(page, label) {
  await expect(page.locator('.entry-card')).toBeVisible();
  await expect(page.locator('.site-header,.hero-copy,.hero-art,.how-it-works,.site-footer')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '女巫的聚会', exact: true })).toBeVisible();
  await expect(page.getByText(/今天[，,]?\s*来点魔法[。.]?/, { exact: true })).toBeVisible();
  await expect(page.locator('.landing .cauldron-art')).toHaveCount(1);
  await expect(page.locator('.entry-card button[type="submit"]')).toBeEnabled();
  await noOverflow(page, label);
  return page.evaluate(() => {
    const card = document.querySelector('.entry-card'), title = [...card.querySelectorAll('h1,h2')].find(node => node.textContent === '女巫的聚会');
    const subtitle = [...card.querySelectorAll('h1,h2,h3,p')].find(node => /今天[，,]?\s*来点魔法/.test(node.textContent));
    const art = document.querySelector('.landing .cauldron-art');
    const rect = node => { const { x, y, width, height, top, right, bottom, left } = node.getBoundingClientRect(); return { x, y, width, height, top, right, bottom, left }; };
    return { card: rect(card), title: rect(title), subtitle: rect(subtitle), cauldron: rect(art), titleAlign: getComputedStyle(title).textAlign, subtitleAlign: getComputedStyle(subtitle).textAlign, viewportWidth: innerWidth };
  });
}
async function openPage(viewport) {
  const page = await browser.newPage({ viewport }), client = { page, state: null };
  await seedInvite(page, { mock: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const message = JSON.parse(String(payload));
    if (message.type === 'state') client.state = message.state;
  }));
  await page.route('**/api/health', route => route.fulfill({ json: server.health }));
  await page.addInitScript(socketURL => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) { super(new URL(url, location.href).pathname === '/ws' ? socketURL : url, protocols); }
    };
  }, `${server.url.replace('http:', 'ws:')}/ws`);
  await page.goto(baseURL);
  return client;
}
try {
  assert.equal((await fetch(baseURL)).ok, true, 'The existing local frontend is available');
  await mkdir('artifacts', { recursive: true });
  server = await fixture({ after: operation => cleanup.push(operation) }, { env: { INVITE_CODE_SHA256: testInviteHash } });
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  for (const [size, viewport, rounds] of scenarios) {
    const host = await openPage(viewport), page = host.page;
    const layout = await landing(page, size), cardCenter = layout.card.left + layout.card.width / 2;
    assert.ok(Math.abs(cardCenter - viewport.width / 2) < 2, `${size}: entry card is horizontally centered`);
    for (const name of ['title', 'subtitle']) {
      assert.equal(layout[`${name}Align`], 'center', `${size}: ${name} text is centered`);
      assert.ok(Math.abs(layout[name].left + layout[name].width / 2 - cardCenter) < 2, `${size}: ${name} aligns with the card center`);
    }
    assert.ok(layout.cauldron.top < layout.card.top && layout.cauldron.bottom > layout.card.top, `${size}: the cauldron peeks over the card's top edge`);
    assert.ok(layout.cauldron.top >= 0, `${size}: the cauldron remains visible above the card`);
    assert.ok(Math.abs(layout.cauldron.left + layout.cauldron.width / 2 - cardCenter) < 2, `${size}: the cauldron is centered over the card`);
    await page.screenshot({ path: `artifacts/landing-simplified-${size}.png`, fullPage: true, animations: 'disabled' });

    const nickname = `入场验收${size}`;
    await page.getByLabel('女巫昵称').fill(nickname);
    await page.getByRole('tab', { name: '加入朋友', exact: true }).click();
    await expect(page.locator('.round-selector')).toHaveCount(0);
    await expect(page.locator('#room-code')).toBeVisible();
    await expect(page.getByLabel('女巫昵称')).toHaveValue(nickname);
    await page.locator('#room-code').fill('abcd');
    await expect(page.locator('#room-code')).toHaveValue('ABCD');
    await noOverflow(page, `${size} join form`);
    await page.screenshot({ path: `artifacts/landing-simplified-${size}-join.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('tab', { name: '开启一场集会', exact: true }).click();
    await expect(page.locator('#room-code')).toHaveCount(0);
    await expect(page.getByLabel('女巫昵称')).toHaveValue(nickname);
    const roundOptions = page.locator('.round-selector button');
    await expect(roundOptions).toHaveCount(3);
    for (let index = 0; index < 3; index++) {
      await roundOptions.nth(index).click();
      await expect(roundOptions.nth(index)).toHaveClass(/selected/);
      await expect(page.locator('.round-selector .selected')).toHaveCount(1);
    }
    await roundOptions.nth([3, 5, 10].indexOf(rounds)).click();
    await page.locator('.entry-card button[type="submit"]').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '开启一场集会', exact: true }).click();
    await until(() => host.state?.phase === 'lobby', 7000, `${size} creates a room`);
    assert.equal(host.state.totalRounds, rounds); assert.equal(host.state.players.find(player => player.id === host.state.me.id).name, nickname);
    await expect(page.locator('.room-lobby')).toBeVisible(); await expect(page.locator('.site-header')).toBeVisible();
    await noOverflow(page, `${size} lobby`);

    const guest = await openPage(viewport), guestName = `朋友${size}`;
    await landing(guest.page, `${size} friend landing`);
    await guest.page.getByRole('tab', { name: '加入朋友', exact: true }).click();
    await guest.page.getByLabel('女巫昵称').fill(guestName);
    await guest.page.locator('#room-code').fill(host.state.id.toLowerCase());
    await guest.page.getByRole('button', { name: '加入这场集会', exact: true }).click();
    await until(() => host.state?.players.length === 2 && guest.state?.players.length === 2, 7000, `${size} joins the room`);
    assert.equal(guest.state.id, host.state.id); assert.equal(guest.state.totalRounds, rounds); assert.equal(guest.state.players.find(player => player.id === guest.state.me.id).name, guestName);
    await expect(guest.page.locator('.site-header')).toBeVisible(); await expect(guest.page.locator('.room-lobby')).toBeVisible();
    await noOverflow(guest.page, `${size} joined lobby`);
    await guest.page.getByRole('button', { name: '离开集会', exact: true }).click();
    await landing(guest.page, `${size} landing after leaving`);
    await until(() => host.state.players.length === 1, 7000, `${size} leaves the room`);
    checks.push({ size, viewport, rounds, layout, centeredTitleAndSubtitle: true, centeredProtrudingCauldron: true, onlyEntryCardOnLanding: true, noHorizontalOverflow: true, createJoinTabs: true, nicknamePreservedAcrossTabs: true, allRoundOptionsWork: true, createAndJoinRealRoom: true, headerReturnsInsideRoom: true, leaveReturnsToSimpleLanding: true });
    await guest.page.close(); await page.close();
  }
  assert.deepEqual(errors, []); assert.equal(server.api.requests.length, 0, 'Landing and lobby checks never call a model');
  report.ok = true;
  await writeFile('artifacts/landing-qa.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  for (const operation of cleanup.reverse()) await operation();
}
