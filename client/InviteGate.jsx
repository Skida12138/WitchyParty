import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, KeyRound, LoaderCircle, LockKeyhole, RotateCcw } from 'lucide-react';
import { hashInviteCode, inviteHeaders, INVITE_STORAGE_KEY, isInviteHash, readStoredInviteHash } from './invite-access.js';
import './invite-gate.css';

const INVALID_MESSAGE = '邀请码不正确或已失效，请重新输入。';
const UNAVAILABLE_MESSAGE = '暂时无法验证邀请，请检查连接后重试。';
const CONFIGURATION_MESSAGE = '聚会邀请尚未开放，请稍后再试。';

function InvitationForm({ busy, onSubmit }) {
  const [code, setCode] = useState('');
  const submit = event => {
    event.preventDefault();
    if (busy || !code.trim()) return;
    const input = code;
    setCode('');
    void onSubmit(input);
  };
  return <form className="invite-form" onSubmit={submit}>
    <label htmlFor="invite-code">邀请码</label>
    <div className="input-wrap invite-input"><KeyRound size={17}/><input id="invite-code" name="invitation" type="password" value={code} onChange={event => setCode(event.target.value)} placeholder="粘贴你的专属邀请码" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={80} disabled={busy} required aria-describedby="invite-description"/></div>
    <button type="submit" className="button primary full invite-submit" disabled={busy || !code.trim()}>{busy ? <LoaderCircle className="spin" size={17}/> : <LockKeyhole size={16}/>}进入聚会<ArrowRight size={17}/></button>
  </form>;
}

// Only this boundary can mount the game. Even a persisted hash must first be
// accepted by the server; retaining it locally never grants access by itself.
export default function InviteGate({ artwork, children }) {
  const [initialStored] = useState(readStoredInviteHash);
  const [access, setAccess] = useState({ phase: isInviteHash(initialStored) ? 'checking' : 'entry', hash: null, retryHash: null, error: '' });
  const activeAccess = useRef(access), observedStorage = useRef(initialStored), revision = useRef(0), request = useRef(null);
  const verifyRef = useRef(null), storageCheckRef = useRef(null);
  activeAccess.current = access;
  const transition = useCallback(next => { activeAccess.current = next; setAccess(next); }, []);

  const clearMatchingStoredHash = useCallback(hash => {
    const stored = readStoredInviteHash();
    if (isInviteHash(stored) && stored.toLowerCase() === hash) {
      try { localStorage.removeItem(INVITE_STORAGE_KEY); } catch {}
    }
    observedStorage.current = readStoredInviteHash();
  }, []);

  const verify = useCallback(async rawHash => {
    if (!isInviteHash(rawHash)) return;
    const hash = rawHash.toLowerCase(), version = ++revision.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const storedAtStart = readStoredInviteHash(); observedStorage.current = storedAtStart;
    transition({ phase: 'checking', hash: null, retryHash: hash, error: '' });
    const timer = setTimeout(() => controller.abort(), 12000);
    const isCurrent = () => {
      if (version !== revision.current) return false;
      if (readStoredInviteHash() !== storedAtStart) { storageCheckRef.current?.(); return false; }
      return true;
    };
    try {
      const response = await fetch('/api/access', { headers: inviteHeaders(hash), signal: controller.signal, cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!isCurrent()) return;
      if (response.status === 401) {
        clearMatchingStoredHash(hash);
        transition({ phase: 'entry', hash: null, retryHash: null, error: INVALID_MESSAGE });
        return;
      }
      if (response.status === 503 && payload?.code === 'INVITE_NOT_CONFIGURED') {
        transition({ phase: 'blocked', hash: null, retryHash: hash, error: CONFIGURATION_MESSAGE });
        return;
      }
      if (!response.ok || payload?.ok !== true) throw new Error('Invitation verification unavailable');
      // Persist only a verified hash. The UUID is never written to storage.
      try { localStorage.setItem(INVITE_STORAGE_KEY, hash); } catch {}
      observedStorage.current = readStoredInviteHash();
      transition({ phase: 'authorized', hash, retryHash: null, error: '' });
    } catch {
      if (isCurrent()) transition({ phase: 'blocked', hash: null, retryHash: hash, error: UNAVAILABLE_MESSAGE });
    } finally {
      clearTimeout(timer);
      if (request.current === controller) request.current = null;
    }
  }, [clearMatchingStoredHash, transition]);
  verifyRef.current = verify;

  const checkStorage = useCallback(() => {
    const stored = readStoredInviteHash();
    if (stored === observedStorage.current) return false;
    observedStorage.current = stored;
    request.current?.abort(); revision.current++;
    if (isInviteHash(stored)) void verifyRef.current(stored);
    else {
      if (stored !== null) { try { localStorage.removeItem(INVITE_STORAGE_KEY); } catch {} }
      observedStorage.current = readStoredInviteHash();
      transition({ phase: 'entry', hash: null, retryHash: null, error: stored === null ? '' : INVALID_MESSAGE });
    }
    return true;
  }, [transition]);
  storageCheckRef.current = checkStorage;

  useEffect(() => {
    const stored = readStoredInviteHash(); observedStorage.current = stored;
    if (isInviteHash(stored)) void verifyRef.current(stored);
    else if (stored !== null) {
      try { localStorage.removeItem(INVITE_STORAGE_KEY); } catch {}
      observedStorage.current = readStoredInviteHash();
      transition({ phase: 'entry', hash: null, retryHash: null, error: INVALID_MESSAGE });
    }
    const storageEvent = event => { if (event.key === INVITE_STORAGE_KEY || event.key === null) checkStorage(); };
    const visible = () => { if (!document.hidden) checkStorage(); };
    window.addEventListener('storage', storageEvent);
    window.addEventListener('focus', checkStorage);
    document.addEventListener('visibilitychange', visible);
    // A same-document localStorage write does not dispatch a storage event.
    const interval = setInterval(checkStorage, 1000);
    return () => {
      revision.current++; request.current?.abort(); clearInterval(interval);
      window.removeEventListener('storage', storageEvent);
      window.removeEventListener('focus', checkStorage);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [checkStorage, transition]);

  const submitCode = useCallback(async code => {
    const version = ++revision.current;
    request.current?.abort();
    transition({ phase: 'checking', hash: null, retryHash: null, error: '' });
    try {
      const hash = await hashInviteCode(code);
      if (version === revision.current) void verifyRef.current(hash);
    } catch (error) {
      if (version === revision.current) transition({ phase: 'entry', hash: null, retryHash: null, error: error.message || INVALID_MESSAGE });
    }
  }, [transition]);

  const invalidate = useCallback((code = 'INVITE_INVALID', rejectedHash) => {
    if (activeAccess.current.phase !== 'authorized' || activeAccess.current.hash !== rejectedHash) return;
    if (checkStorage()) return;
    request.current?.abort(); revision.current++;
    if (code === 'INVITE_INVALID') clearMatchingStoredHash(rejectedHash);
    transition({ phase: code === 'INVITE_INVALID' ? 'entry' : 'blocked', hash: null, retryHash: code === 'INVITE_INVALID' ? null : rejectedHash, error: code === 'INVITE_NOT_CONFIGURED' ? CONFIGURATION_MESSAGE : INVALID_MESSAGE });
  }, [checkStorage, clearMatchingStoredHash, transition]);

  if (access.phase === 'authorized') return children({ inviteHash: access.hash, onInviteInvalid: invalidate });
  const busy = access.phase === 'checking';
  return <div className="app-shell is-landing"><main className="landing landing-compact invite-gate" data-access-state={access.phase}>
    <section className="entry-card landing-entry-card invite-card" aria-labelledby="invite-title" aria-busy={busy}>
      {artwork}
      <div className="landing-entry-heading"><h1 id="invite-title">女巫的聚会</h1><p>输入邀请码</p></div>
      <InvitationForm busy={busy} onSubmit={submitCode}/>
      {busy && <p className="invite-checking" role="status"><LoaderCircle className="spin" size={14}/>正在验证邀请…</p>}
      {access.error && <p className="invite-error" role="alert">{access.error}</p>}
      {!busy && access.retryHash && <button className="button ghost full invite-retry" onClick={() => { if (!checkStorage()) void verify(access.retryHash); }}><RotateCcw size={15}/><span>重新验证</span></button>}
      <p id="invite-description" className="invite-description">这是进入游戏的邀请，与房间码不同。<br/>进入后，再创建或加入一场集会。</p>
    </section>
  </main></div>;
}
