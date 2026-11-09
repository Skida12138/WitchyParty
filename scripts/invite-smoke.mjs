import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDeepSeekStub } from '../tests/helpers/deepseek-stub.js';
import { inviteHeaders, testInviteCode, testInviteHash } from './helpers/invite-fixture.mjs';

// This test owns its HTTP stub, server and browser. These public fixture
// credentials are unrelated to the real invite; no .env file is loaded.
const root = fileURLToPath(new URL('..', import.meta.url));
const wrongCode = '40a78a1c-9e62-4f85-8d20-5c13f6b97e04';
const wrongHash = createHash('sha256').update(wrongCode).digest('hex');
const report = { ok: false, isolatedLocalServer: true, realModelCalls: 0, checks: [], pageErrors: [], consoleErrors: [], consoleWarnings: [], expectedAccessFailures: 0 };
let browser, child, stub, serverOutput = '', url;
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await delay(15); }
}
async function build() {
  const process = spawn(globalThis.process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; process.stdout.on('data', data => { output += data; }); process.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => process.once('exit', resolve).once('error', reject));
  assert.equal(code, 0, output);
}
async function openPage(viewport, { storedHash, networkFailure = false } = {}) {
  const page = await browser.newPage({ viewport }), client = { page, state: null, socketCount: 0, sent: [], health: [], access: [] };
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      if (message.location().url.includes('/api/access') && /401|ERR_FAILED/.test(message.text())) report.expectedAccessFailures++;
      else report.consoleErrors.push(message.text());
    } else if (message.type() === 'warning') report.consoleWarnings.push(message.text());
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/health') client.health.push(request.headers()['x-invite-hash']);
    if (path === '/api/access') client.access.push(request.headers()['x-invite-hash']);
  });
  page.on('websocket', socket => {
    client.socketCount++;
    socket.on('framesent', ({ payload }) => { try { client.sent.push(JSON.parse(String(payload))); } catch {} });
    socket.on('framereceived', ({ payload }) => { const message = JSON.parse(String(payload)); if (message.type === 'state') client.state = message.state; });
  });
  await page.addInitScript(hash => {
    if (hash !== undefined && !sessionStorage.getItem('invite-fixture-seeded')) {
      localStorage.setItem('witchy-invite-hash', hash);
      sessionStorage.setItem('invite-fixture-seeded', '1');
    }
    window.__inviteSockets = []; window.__inviteWsCalls = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(address, protocols) {
        super(address, protocols);
        window.__inviteSockets.push(this); window.__inviteWsCalls.push({ address, protocols });
      }
    };
  }, storedHash);
  if (networkFailure) {
    let unavailable = true;
    client.restoreNetwork = () => { unavailable = false; };
    await page.route('**/api/access', async route => {
      if (unavailable) await route.abort('failed');
      else await route.continue();
    });
  }
  await page.goto(url);
  return client;
}
async function assertGate(client, label) {
  await expect(client.page.locator('.invite-gate')).toBeVisible();
  await expect(client.page.locator('.entry-card:not(.invite-card),.site-header,.room-lobby')).toHaveCount(0);
  assert.equal(await client.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
}
async function enter(client, code = testInviteCode) {
  await client.page.locator('#invite-code').fill(code);
  await client.page.locator('.invite-submit').click();
}
try {
  await mkdir('artifacts', { recursive: true }); await build();
  stub = await createDeepSeekStub();
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), INVITE_CODE_SHA256: testInviteHash,
    DEEPSEEK_API_KEY: 'invite-smoke-local-only', DEEPSEEK_BASE_URL: stub.url, ROOM_LOG_ENABLED: '0',
    RECONNECT_GRACE_MS: '15000', HEARTBEAT_INTERVAL_MS: '1000', HEARTBEAT_TIMEOUT_MS: '1000',
  } });
  child.stdout.on('data', data => { serverOutput += data; }); child.stderr.on('data', data => { serverOutput += data; });
  url = `http://127.0.0.1:${port}`;
  await until(async () => { assert.equal(child.exitCode, null, serverOutput); try { return (await fetch(`${url}/api/health`, { headers: inviteHeaders })).ok; } catch { return false; } }, 'isolated invite server starts');
  for (const endpoint of ['/api/access', '/api/health']) {
    for (const headers of [{}, { 'X-Invite-Hash': wrongHash }]) {
      const response = await fetch(`${url}${endpoint}`, { headers }), body = await response.text();
      assert.equal(response.status, 401); assert.ok(!body.includes(testInviteHash) && !body.toLowerCase().includes(testInviteCode));
    }
    const response = await fetch(`${url}${endpoint}`, { headers: inviteHeaders });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  }
  const assets = ['index.html', ...(await readdir(new URL('../dist/assets/', import.meta.url))).filter(name => /\.(js|css)$/.test(name)).map(name => `assets/${name}`)];
  for (const asset of assets) {
    const source = await readFile(new URL(`../dist/${asset}`, import.meta.url), 'utf8');
    assert.ok(!source.toLowerCase().includes(testInviteCode) && !source.includes(testInviteHash), 'Browser assets contain no fixture invite credentials');
  }
  report.checks.push({ endpointsRejectMissingAndWrongHash: true, authorizedEndpointsSucceed: true, rejectionDoesNotRevealExpectedHash: true, fixtureInviteAbsentFromBrowserAssets: true });
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });

  const desktop = await openPage({ width: 1440, height: 1000 });
  await assertGate(desktop, 'desktop'); await delay(150);
  assert.equal(desktop.socketCount, 0); assert.equal(desktop.health.length, 0);
  await desktop.page.screenshot({ path: 'artifacts/invite-gate-desktop.png', fullPage: true });
  await enter(desktop, wrongCode);
  await expect(desktop.page.locator('.invite-error')).toBeVisible(); await assertGate(desktop, 'wrong invite');
  assert.equal(desktop.socketCount, 0);
  assert.equal(await desktop.page.evaluate(() => localStorage.getItem('witchy-invite-hash')), null);
  await enter(desktop, `  ${testInviteCode.toUpperCase()}  `);
  await expect(desktop.page.locator('.entry-card:not(.invite-card)')).toBeVisible(); await expect(desktop.page.locator('.invite-gate')).toHaveCount(0);
  await until(() => desktop.socketCount === 1 && desktop.health.length > 0, 'authorized game connects');
  const storage = await desktop.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  assert.equal(storage['witchy-invite-hash'], testInviteHash);
  assert.ok(Object.values(storage).every(value => !value.toLowerCase().includes(testInviteCode)));
  assert.ok(desktop.health.every(hash => hash === testInviteHash));
  assert.equal(desktop.access.at(-1), testInviteHash);
  const calls = await desktop.page.evaluate(() => window.__inviteWsCalls);
  assert.deepEqual(calls[0].protocols, ['witchy-v1', `invite.${testInviteHash}`]);
  assert.ok(calls.every(call => !call.address.includes(testInviteHash)), 'Credential never appears in a WebSocket URL');
  await desktop.page.getByLabel('女巫昵称').fill('门禁验收女巫');
  await desktop.page.getByRole('button', { name: '开启一场集会', exact: true }).click();
  await until(() => desktop.state?.phase === 'lobby', 'authorized create room');
  const roomId = desktop.state.id, identity = await desktop.page.evaluate(() => sessionStorage.getItem('witchy-session'));
  assert.ok(desktop.sent.some(message => message.type === 'create'));
  assert.ok(desktop.sent.every(message => message.inviteHash === testInviteHash));
  desktop.state = null; await desktop.page.reload();
  await until(() => desktop.state?.phase === 'lobby', 'authorized refresh resumes room');
  assert.equal(desktop.state.id, roomId);
  assert.equal(await desktop.page.evaluate(() => sessionStorage.getItem('witchy-session')), identity);
  await expect(desktop.page.locator('.invite-gate')).toHaveCount(0);
  assert.ok(desktop.sent.some(message => message.type === 'resume' && message.inviteHash === testInviteHash));
  await desktop.page.screenshot({ path: 'artifacts/invite-authorized-room-desktop.png', fullPage: true });

  // An authenticated socket must still reject a single tampered JSON message.
  // It cannot add a bot or trigger any model operation before this check.
  await desktop.page.evaluate(hash => window.__inviteSockets.at(-1).send(JSON.stringify({ type: 'action', requestId: 'invalid-invite-fixture', inviteHash: hash, payload: { action: 'addBot' } })), wrongHash);
  await assertGate(desktop, 'expired socket credential');
  await until(async () => await desktop.page.evaluate(() => localStorage.getItem('witchy-invite-hash')) === null, 'invalid socket clears credential');
  const socketsAfterInvalidation = desktop.socketCount;
  await delay(1800); assert.equal(desktop.socketCount, socketsAfterInvalidation, 'Invalid invite stops the reconnect loop');
  assert.equal(await desktop.page.evaluate(() => sessionStorage.getItem('witchy-session')), identity, 'An invalid invite does not destroy the resumable game identity');
  await desktop.page.screenshot({ path: 'artifacts/invite-expired-desktop.png', fullPage: true });
  report.checks.push({ unverifiedShowsOnlyGate: true, noUnauthorizedWebSocketOrHealth: true, wrongInviteNotStored: true, uppercaseAndWhitespaceNormalized: true, onlyHashStored: true, healthUsesInviteHeader: true, webSocketProtocolsAndMessagesAuthenticated: true, refreshResumesRoomWithoutReentry: true, invalidMessageReturnsToGate: true, noReconnectAfterInvalidation: true, roomIdentityPreservedOnInvalidation: true });

  for (const storedHash of ['not-a-valid-hash', wrongHash]) {
    const invalid = await openPage({ width: 390, height: 844 }, { storedHash });
    await assertGate(invalid, 'invalid stored credential');
    await until(async () => await invalid.page.evaluate(() => localStorage.getItem('witchy-invite-hash')) === null, 'invalid saved hash removed');
    await delay(150); assert.equal(invalid.socketCount, 0); await invalid.page.close();
  }
  const retry = await openPage({ width: 390, height: 844 }, { storedHash: testInviteHash, networkFailure: true });
  await assertGate(retry, 'access network failure'); await expect(retry.page.locator('.invite-retry')).toBeVisible();
  assert.equal(await retry.page.evaluate(() => localStorage.getItem('witchy-invite-hash')), testInviteHash);
  assert.equal(retry.socketCount, 0);
  await retry.page.screenshot({ path: 'artifacts/invite-network-retry-mobile.png', fullPage: true });
  retry.restoreNetwork();
  await retry.page.locator('.invite-retry').click();
  await expect(retry.page.locator('.entry-card:not(.invite-card)')).toBeVisible(); await until(() => retry.socketCount === 1, 'network retry enters game');
  assert.equal(await retry.page.evaluate(() => localStorage.getItem('witchy-invite-hash')), testInviteHash);
  report.checks.push({ invalidStoredHashReturnsToGate: true, networkFailurePreservesCredential: true, networkRetrySucceeds: true });
  await retry.page.close();

  for (const [size, viewport] of [['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 700 }]]) {
    const client = await openPage(viewport);
    await assertGate(client, size); assert.equal(client.socketCount, 0);
    await client.page.screenshot({ path: `artifacts/invite-gate-${size}.png`, fullPage: true });
    await enter(client, 'not-a-uuid');
    await expect(client.page.locator('.invite-error')).toBeVisible(); await assertGate(client, `${size} invalid format`);
    assert.equal(client.socketCount, 0);
    await enter(client); await expect(client.page.locator('.entry-card:not(.invite-card)')).toBeVisible();
    assert.equal(await client.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    report.checks.push({ size, viewport, gateAndErrorWithoutOverflow: true, validInviteEntersLanding: true });
    await client.page.close();
  }
  assert.equal(stub.requests.length, 0, 'Invite testing never calls a model');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
  await writeFile('artifacts/invite-qa.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, delay(2000)]); }
  await stub?.close();
}
