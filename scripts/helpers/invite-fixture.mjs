import { createHash } from 'node:crypto';

// Public, test-only credentials for isolated QA servers. Never load production
// invite settings here or include this module in the browser bundle.
export const testInviteCode = 'c14f7b36-8d09-4a62-93cb-19e5d2740a86';
export const testInviteHash = createHash('sha256').update(testInviteCode).digest('hex');
export const inviteHeaders = { 'X-Invite-Hash': testInviteHash };

export async function seedInvite(page, { mock = false } = {}) {
  await page.addInitScript(hash => localStorage.setItem('witchy-invite-hash', hash), testInviteHash);
  if (mock) {
    const reply = health => async route => {
      const valid = route.request().headers()['x-invite-hash'] === testInviteHash;
      await route.fulfill({ status: valid ? 200 : 401, json: valid ? { ok: true, ...(health ? { aiReady: true, mode: 'test' } : {}) } : { ok: false, code: 'INVITE_INVALID', message: '邀请码无效' } });
    };
    await page.route('**/api/access', reply(false));
    await page.route('**/api/health', reply(true));
  }
}
