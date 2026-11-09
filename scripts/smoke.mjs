import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDeepSeekStub } from '../tests/helpers/deepseek-stub.js';
import { inviteHeaders, seedInvite, testInviteHash } from './helpers/invite-fixture.mjs';

// This smoke always starts its own local API stub and game server. It cannot
// connect to the configured production provider or spend a real API balance.
const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [], consoleErrors = [], consoleWarnings = [], clients = [], rounds = [];
const hostMaterial = '初夏月光绕成的茶匙', guestMaterial = '轻轻打盹的薄荷糖';
let browser, child, stub, serverOutput = '';
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await delay(15); }
}
async function command(args) {
  const process = spawn(globalThis.process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; process.stdout.on('data', data => { output += data; }); process.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => process.once('exit', resolve).once('error', reject));
  assert.equal(code, 0, output);
}
async function noOverflow(page, label) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label} overflow`); }
async function noChat(page) { await expect(page.locator('.room-chat,[data-chat-root],.chat-toggle')).toHaveCount(0); await expect(page.getByRole('textbox', { name: '聊天消息', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: /聊天/ })).toHaveCount(0); }
async function quote(client, name, count = 1) {
  await client.page.getByRole('button', { name: '想一份材料', exact: true }).click();
  await client.page.getByLabel('材料名称', { exact: true }).fill(name);
  await client.page.getByRole('button', { name: '召唤这份材料', exact: true }).click();
  await client.page.locator('.quality-card').nth(count - 1).waitFor({ timeout: 15000 });
  await expect(client.page.locator('.imagination-dialog')).toHaveCount(0);
}
async function ready(client, name) {
  await client.page.locator('.quality-card').filter({ has: client.page.locator('strong', { hasText: name }) }).click();
  await client.page.getByRole('button', { name: '准备好了', exact: true }).click();
}
async function shot(client, phase) {
  await noOverflow(client.page, `${client.size} ${phase}`);
  await noChat(client.page);
  await client.page.screenshot({ path: `artifacts/smoke-${phase}-${client.size}.png`, fullPage: true, animations: 'disabled' });
}
try {
  await mkdir('artifacts', { recursive: true });
  await command(['node_modules/vite/bin/vite.js', 'build']);
  stub = await createDeepSeekStub({ prices: { [hostMaterial]: 120, [guestMaterial]: 40, '灯芯里的小雨燕': 180 } });
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), DEEPSEEK_API_KEY: 'local-smoke-test-only', DEEPSEEK_BASE_URL: stub.url, INVITE_CODE_SHA256: testInviteHash,
    ROOM_LOG_ENABLED: '0', DEPOSIT_MS: '800', REACTION_MS: '1000', HOLD_MS: '1500', CHAIN_HOLD_MS: '1000',
    RECONNECT_GRACE_MS: '30000', HEARTBEAT_INTERVAL_MS: '10000', HEARTBEAT_TIMEOUT_MS: '10000',
  } });
  child.stdout.on('data', data => { serverOutput += data; }); child.stderr.on('data', data => { serverOutput += data; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${url}/api/health`, { headers: inviteHeaders })).ok) break; } catch {}
    assert.equal(child.exitCode, null, serverOutput); await delay(40);
  }
  const health = await (await fetch(`${url}/api/health`, { headers: inviteHeaders })).json(); assert.equal(health.aiReady, true);
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await seedInvite(page);
    const client = { page, size, state: null, states: [], requests: [] }; clients.push(client);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${size}: ${message.text()}`); else if (message.type() === 'warning') consoleWarnings.push(`${size}: ${message.text()}`); });
    page.on('request', request => { if (!request.url().startsWith(url)) client.requests.push(request.url()); });
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'state') { client.state = message.state; client.states.push({ state: message.state, at: Date.now() }); }
    }));
    await page.goto(url);
    await expect(page.getByText('出牌轮数', { exact: true })).toBeVisible();
    await shot(client, 'landing');
  }
  const [host, guest] = clients;
  await host.page.getByLabel('女巫昵称').fill('晴天女巫');
  await host.page.getByRole('button', { name: '开启一场集会', exact: true }).click();
  await until(() => host.state?.phase === 'lobby', 'create lobby');
  await guest.page.getByRole('tab', { name: '加入朋友' }).click();
  await guest.page.getByLabel('女巫昵称').fill('薄荷女巫');
  await guest.page.locator('#room-code').fill(host.state.id);
  await guest.page.getByRole('button', { name: '加入这场集会', exact: true }).click();
  await until(() => clients.every(client => client.state?.players.length === 2), 'both players join');
  await Promise.all(clients.map(client => noChat(client.page)));
  const savedIdentity = await guest.page.evaluate(() => JSON.parse(sessionStorage.getItem('witchy-session')));
  guest.state = null; await guest.page.reload();
  await until(() => guest.state?.phase === 'lobby', 'refresh resumes lobby');
  assert.deepEqual(await guest.page.evaluate(() => JSON.parse(sessionStorage.getItem('witchy-session'))), savedIdentity);
  assert.ok(!('chat' in guest.state));
  await shot(guest, 'identity-restored');
  await shot(host, 'room');
  await host.page.getByRole('button', { name: '开始今天的集会', exact: true }).click();
  let balances = new Map([[host.state.me.id, 20000], [guest.state.me.id, 20000]]);
  for (let round = 1; round <= 3; round++) {
    await until(() => clients.every(client => client.state.phase === 'preparing' && client.state.round === round), `round ${round} preparing`);
    for (const client of clients) assert.equal(client.state.me.coins, balances.get(client.state.me.id), 'Balance carries into next round');
    await Promise.all([quote(host, hostMaterial), quote(guest, guestMaterial)]);
    assert.equal(JSON.stringify(guest.state).includes(hostMaterial), false, 'Other material is private during preparation');
    await ready(guest, guestMaterial);
    await until(() => !!guest.state.me.preparedQuoteId, 'guest ready');
    assert.equal(guest.state.me.coins, balances.get(guest.state.me.id), 'Ready does not charge gold');
    await expect(guest.page.locator('.preparation-waiting-overlay')).toBeVisible();
    if (round === 1) {
      await guest.page.getByRole('button', { name: '重新选择', exact: true }).click();
      await until(() => !guest.state.me.preparedQuoteId, 'unready');
      assert.equal(guest.state.me.quotes.length, 1);
      await ready(guest, guestMaterial);
      await quote(host, '月光蘑菇', 2); await quote(host, '一颗迷路的星星', 3);
      assert.equal(await host.page.getByRole('button', { name: '想一份材料', exact: true }).count(), 0);
      await Promise.all([shot(host, 'preparing'), shot(guest, 'waiting')]);
    }
    const marker = host.states.length;
    await ready(host, hostMaterial);
    await Promise.all(clients.map(client => client.page.locator('.presentation-board').waitFor()));
    for (const client of clients) {
      assert.equal(client.state.phase, 'performing');
      assert.equal(client.state.roundResult, null);
      assert.equal(client.state.me.coins, balances.get(client.state.me.id) - (client === host ? 120 : 40));
      await expect(client.page.locator('.public-card,.public-materials,.round-stirring')).toHaveCount(0);
      await expect(client.page.locator('.coin-rank-row')).toHaveCount(0);
      await noChat(client.page);
    }
    if (round === 1) await Promise.all(clients.map(client => shot(client, 'performing')));
    await until(() => clients.every(client => client.state.round === round && ['roundEnd', 'finished'].includes(client.state.phase)), `round ${round} ranking`);
    const result = host.state.roundResult;
    assert.equal(result.reason, 'highest-contribution'); assert.equal(result.winnerId, host.state.me.id);
    for (const row of result.players) {
      assert.equal(row.before, balances.get(row.id)); assert.equal(row.balance, row.before - row.cost + row.winnings);
      assert.equal(row.delta, row.balance - row.before); assert.equal(host.state.players.find(player => player.id === row.id).coins, row.balance);
      balances.set(row.id, row.balance);
    }
    for (const client of clients) {
      await expect(client.page.locator('.winner-celebration')).toHaveAttribute('data-celebration-id', result.winnerCelebration.id);
      await expect(client.page.locator('.winner-celebration')).toHaveAttribute('data-winner-id', result.winnerId);
      await expect(client.page.locator('.winner-material-price')).toHaveAttribute('data-price', '120');
      await expect(client.page.locator('.coin-rank-row')).toHaveCount(0);
      if (round === 1) await shot(client, 'winner');
      await client.page.locator('.winner-continue').click();
      await expect(client.page.locator('.winner-celebration')).toHaveCount(0);
      await expect(client.page.locator('.coin-rank-row')).toHaveCount(2);
      const displayedBalances = (await client.page.locator('.coin-rank-balance strong').allTextContents()).map(value => Number(value.replaceAll(',', '')));
      assert.deepEqual(displayedBalances, result.players.map(player => player.balance).sort((a, b) => b - a), 'Ranking follows current gold, with tied players allowed in either order');
      await expect(client.page.locator('body')).not.toContainText(/魔力|历史记录|派对积分|喝下|去留决定/);
      assert.ok(!client.states.some(entry => ['revealing', 'decision', 'animating'].includes(entry.state.phase)));
      await noOverflow(client.page, `${client.size} round ${round} ranking`);
    }
    const phaseEvents = host.states.slice(marker), calculation = phaseEvents.find(entry => entry.state.phase === 'resolving'), perform = phaseEvents.find(entry => entry.state.phase === 'performing'), end = phaseEvents.find(entry => ['roundEnd', 'finished'].includes(entry.state.phase));
    assert.ok(calculation && perform && end);
    assert.ok(perform.at - calculation.at < 1000, 'Local model responses finish without a synthetic waiting period');
    const frames = [...new Map(phaseEvents.filter(entry => entry.state.phase === 'performing').map(entry => [entry.state.presentation.id, entry.state.presentation])).values()];
    assert.equal(frames.length, perform.state.presentation.total); assert.equal(frames.filter(frame => frame.kind === 'deposit').length, 2);
    assert.deepEqual(frames.map(frame => frame.index), frames.map((_, index) => index));
    for (const [index, frame] of frames.entries()) {
      const nextFrame = frames[index + 1];
      const continuesReaction = nextFrame?.kind === 'reaction' && nextFrame.playerId === frame.playerId;
      assert.equal(frame.holdMs, continuesReaction ? 1000 : 1500); assert.equal(frame.durationMs, frame.animationMs + frame.holdMs);
      const nextStartedAt = index + 1 < frames.length ? frames[index + 1].startedAt : end.state.serverTime;
      assert.ok(nextStartedAt - frame.startedAt - frame.animationMs >= frame.holdMs - 5, 'Each animation receives its full chain or completion hold');
    }
    for (const entry of phaseEvents.filter(entry => entry.state.phase === 'performing')) {
      assert.equal(entry.state.roundResult, null); assert.ok(!('chat' in entry.state));
      for (const player of entry.state.players) assert.equal(player.coins, calculation.state.players.find(item => item.id === player.id).coins);
    }
    assert.ok(end.at - perform.at >= frames.reduce((sum, frame) => sum + frame.durationMs, 0) - 100);
    rounds.push({ round, phase: host.state.phase, order: perform.state.players.map(player => player.name), potValue: result.potValue, players: result.players.map(({ name, before, cost, winnings, balance, delta }) => ({ name, before, cost, winnings, balance, delta })), computationMs: perform.at - calculation.at, performanceMs: end.at - perform.at, frames: frames.map(({ kind, index, animationMs, holdMs, durationMs }) => ({ kind, index, animationMs, holdMs, durationMs })) });
    if (round < 3) {
      if (round === 1) await Promise.all(clients.map(client => shot(client, 'ranking')));
      await host.page.getByRole('button', { name: `开始第 ${round + 1} 轮出牌`, exact: true }).click();
    }
  }
  assert.equal(host.state.phase, 'finished'); assert.equal(host.state.finishReason, 'round-limit');
  const greatestBalance = Math.max(...balances.values());
  assert.deepEqual(new Set(host.state.matchWinnerIds), new Set([...balances].filter(([, balance]) => balance === greatestBalance).map(([id]) => id)));
  assert.equal(guest.state.me.coins, 19880); assert.equal(host.state.me.coins, balances.get(host.state.me.id));
  await Promise.all(clients.map(client => shot(client, 'finished')));
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.ok(clients.every(client => client.requests.length === 0), 'Browser uses only its temporary local service');
  assert.ok(stub.count('price') >= 2, 'Production provider exercised against local HTTP stub');
  const report = { ok: true, realBrowserAndWebSocket: true, isolatedLocalServer: true, realModelCalls: 0, rounds: 3, humanPlayers: 2, desktopAndMobile: true, noChatUIOrState: true, refreshPreservesIdentity: true, noRevealStageOrArtificialWait: true, perFrameChainAndCompletionHolds: true, fullPerformanceBeforeRanking: true, winnerConfirmationBeforeRanking: true, originalWinnerPriceShown: true, goldAndDeltaVerified: true, crossRoundBalancesRetained: true, quoteSelectionAndUnready: true, noLegacyPhasesOrViews: true, noHorizontalOverflow: true, pageErrors: errors, consoleErrors, consoleWarnings, localStubRequests: { price: stub.count('price'), synthesize: stub.count('synthesize') }, results: rounds };
  await writeFile('artifacts/smoke-qa.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, delay(2000)]); }
  await stub?.close();
}

