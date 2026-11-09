export const INVITE_STORAGE_KEY = 'witchy-invite-hash';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isInviteHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
export const inviteHeaders = hash => ({ 'X-Invite-Hash': hash });

export function readStoredInviteHash() {
  try { return localStorage.getItem(INVITE_STORAGE_KEY); } catch { return null; }
}

export async function hashInviteCode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_V4.test(normalized)) throw new Error('请输入完整、有效的邀请码。');
  if (!globalThis.crypto?.subtle) throw new Error('请通过 HTTPS 或本机地址打开页面后再验证邀请。');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
