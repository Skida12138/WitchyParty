import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { inviteHeaders, seedInvite } from './helpers/invite-fixture.mjs';

// This uses the configured server and may make paid DeepSeek calls.
const url = process.env.PREVIEW_URL || 'http://127.0.0.1:3001';
const health = await (await fetch(`${url}/api/health`, { headers: inviteHeaders })).json();
assert.equal(health.mode, 'deepseek');
assert.equal(health.aiReady, true, 'Configure the server before testing AI players');
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const errors = [], clients = [];
async function until(predicate, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('AI room state did not arrive'); await delay(30); }
}
try {
  for (let index = 0; index < 2; index++) {
    const page = await browser.newPage({ viewport: index ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    await seedInvite(page);
    const client = { page, state: null }; clients.push(client);
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'state') client.state = message.state;
      if (message.type === 'error') errors.push(message.message);
    }));
    await page.goto(url);
    assert.equal(await page.getByText('和陪练女巫开启集会', { exact: true }).count(), 0);
  }
  const [host, guest] = clients;
  await host.page.getByLabel('女巫昵称').fill('晴天女巫');
  await host.page.getByRole('button', { name: '开启一场集会', exact: true }).click();
  await until(() => host.state?.phase === 'lobby');
  await guest.page.getByRole('tab', { name: '加入朋友' }).click();
  await guest.page.getByLabel('女巫昵称').fill('午茶女巫');
  await guest.page.locator('#room-code').fill(host.state.id);
  await guest.page.getByRole('button', { name: '加入这场集会', exact: true }).click();
  await until(() => host.state.players.length === 2);
  for (let count = 3; count <= 4; count++) {
    await host.page.getByRole('button', { name: '添加 AI 女巫', exact: true }).click();
    await until(() => host.state.players.length === count);
  }
  assert.equal(host.state.players.filter(player => player.bot).length, 2);
  assert.equal(await guest.page.getByRole('button', { name: '添加 AI 女巫' }).count(), 0);
  await host.page.screenshot({ path: 'artifacts/ai-room-desktop.png', fullPage: true });
  await guest.page.screenshot({ path: 'artifacts/ai-room-mobile.png', fullPage: true });
  await host.page.getByRole('button', { name: '开始今天的集会', exact: true }).click();
  for (const client of clients) await client.page.locator('.turn-overlay').waitFor();
  await Promise.all(clients.map(async client => {
    const page = client.page;
    await page.getByRole('button', { name: '想一份材料', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: '想一份材料', exact: true }).click();
    await page.getByLabel('材料名称', { exact: true }).fill('晨露');
    await page.getByRole('button', { name: '召唤这份材料', exact: true }).click();
    await page.getByRole('button', { name: '选择晨露，消耗5魔力', exact: true }).click();
    await page.getByRole('button', { name: '准备好了', exact: true }).click();
  }));
  await until(() => host.state.phase === 'decision', 90000);
  const ai = host.state.players.filter(player => player.bot);
  for (const player of ai) assert.ok(host.state.log.some(entry => entry.text.includes(`${player.name} 投入了一份材料`)));
  await until(() => host.state.players.filter(player => player.bot).every(player => player.decision?.confirmed), 9000);
  await host.page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.decision-overlay')).opacity) >= .99);
  await host.page.screenshot({ path: 'artifacts/ai-room-decisions.png', fullPage: true });
  for (const client of clients) {
    assert.equal(await client.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await client.page.getByRole('button', { name: /这轮先到这里/ }).click();
    await client.page.getByRole('button', { name: '确认我的决定', exact: true }).click();
  }
  await until(() => host.state.phase !== 'decision');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, mode: health.mode, ordinaryRoom: true, humans: 2, aiPlayers: 2, aiDeposits: 2, aiConfirmations: 2, pageErrors: 0 }));
} finally { await browser.close(); }
