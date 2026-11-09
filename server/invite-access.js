import { timingSafeEqual } from 'node:crypto';

export const INVITE_PROTOCOL = 'witchy-v1';
const hashPattern = /^[a-f0-9]{64}$/i;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createInviteAccess(configuredHash) {
  const expected = typeof configuredHash === 'string' && hashPattern.test(configuredHash) ? Buffer.from(configuredHash, 'hex') : null;
  return {
    configured: Boolean(expected),
    assertHash(candidate) {
      if (!expected) throw Object.assign(new Error('邀请码尚未配置，请联系房主。'), { code: 'INVITE_NOT_CONFIGURED', status: 503 });
      if (typeof candidate !== 'string' || !hashPattern.test(candidate) || !timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) {
        throw Object.assign(new Error('邀请码无效，请重新输入。'), { code: 'INVITE_INVALID', status: 401 });
      }
    },
  };
}

// Authentication travels in a nonselected protocol token, never in the URL.
// Only the public application protocol is echoed in the successful handshake.
export function inviteHashFromProtocols(header) {
  if (typeof header !== 'string') return null;
  const protocols = header.split(',').map(value => value.trim());
  if (protocols.length !== 2 || !protocols.includes(INVITE_PROTOCOL)) return null;
  const credential = protocols.find(value => value.startsWith('invite.'))?.slice('invite.'.length);
  return typeof credential === 'string' && hashPattern.test(credential) ? credential : null;
}

export function allowedSocketOrigin(origin, host) {
  if (origin === undefined) return true;
  try {
    if (typeof origin !== 'string' || typeof host !== 'string') return false;
    const source = new URL(origin), target = new URL(`http://${host}`);
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || target.username || target.password) return false;
    return source.hostname === target.hostname || loopbackHosts.has(source.hostname) && loopbackHosts.has(target.hostname);
  } catch { return false; }
}
