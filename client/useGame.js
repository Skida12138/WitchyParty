import { useCallback, useEffect, useRef, useState } from 'react';
import { inviteHeaders, isInviteHash } from './invite-access.js';

const SESSION_KEY = 'witchy-session';
const TERMINAL_CODES = new Set(['ROOM_CLOSED', 'SESSION_EXPIRED', 'PLAYER_REMOVED', 'REMOVED']);
const readSession = () => {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    return value && ['roomId', 'playerId', 'token'].every(key => typeof value[key] === 'string' && value[key]) ? value : null;
  } catch { return null; }
};
const persistSession = value => {
  try { value ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)) : sessionStorage.removeItem(SESSION_KEY); } catch {}
};

export default function useGame({ inviteHash, onInviteInvalid }) {
  const [initialSession] = useState(readSession);
  const [state, setState] = useState(null);
  const [hasSession, setHasSession] = useState(!!initialSession);
  const [connection, setConnection] = useState(initialSession ? 'resuming' : 'connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [healthReady, setHealthReady] = useState(null);
  const [healthStatus, setHealthStatus] = useState('checking');
  const [generation, setGeneration] = useState(0);
  const socket = useRef(null), session = useRef(initialSession), requests = useRef(new Map()), seq = useRef(0), ready = useRef(false);
  const inviteInvalid = useRef(onInviteInvalid);
  inviteInvalid.current = onInviteInvalid;
  const updatePending = () => {
    const remaining = [...requests.current.values()];
    setPending(remaining.at(-1)?.label || '');
  };

  useEffect(() => {
    let stopped = false, halted = false, retry, handshake, resumeTimeout, retries = 0, healthRequest, accessRequest, accessTimer, ownedSocket;
    const settleRequests = (ws, render = true) => {
      for (const [id, request] of requests.current) if (request.ws === ws) {
        clearTimeout(request.timer); requests.current.delete(id); request.resolve(false);
      }
      if (render) updatePending();
    };
    const stopForInvite = (code = 'INVITE_INVALID') => {
      if (stopped || halted) return;
      halted = true; clearTimeout(retry); clearTimeout(handshake); clearTimeout(resumeTimeout); clearTimeout(accessTimer);
      healthRequest?.abort(); accessRequest?.abort();
      ready.current = false; settleRequests(ownedSocket);
      if (socket.current === ownedSocket) socket.current = null;
      ownedSocket?.close();
      setConnection('invite-invalid');
      // Keep the room session so a fresh invitation can resume the same seat.
      inviteInvalid.current?.(code, inviteHash);
    };
    const checkAI = async isCurrent => {
      healthRequest?.abort();
      const request = new AbortController(); healthRequest = request;
      setHealthReady(null); setHealthStatus('checking');
      try {
        const response = await fetch('/api/health', { headers: inviteHeaders(inviteHash), signal: request.signal, cache: 'no-store' });
        if (response.status === 401) { if (isCurrent()) stopForInvite(); return; }
        if (response.status === 503) {
          const failure = await response.json().catch(() => null);
          if (failure?.code === 'INVITE_NOT_CONFIGURED') { if (isCurrent()) stopForInvite('INVITE_NOT_CONFIGURED'); return; }
        }
        if (!response.ok) throw new Error('Health check failed');
        const health = await response.json();
        if (typeof health.aiReady !== 'boolean') throw new Error('Health state unavailable');
        if (isCurrent() && !request.signal.aborted) { setHealthReady(health.aiReady); setHealthStatus('checked'); }
      } catch {
        if (isCurrent() && !request.signal.aborted) { setHealthReady(null); setHealthStatus('unavailable'); }
      }
    };
    const verifyBeforeReconnect = async () => {
      if (stopped || halted) return;
      accessRequest?.abort();
      const request = new AbortController(); accessRequest = request;
      accessTimer = setTimeout(() => request.abort(), 12000);
      let verified = false;
      try {
        const response = await fetch('/api/access', { headers: inviteHeaders(inviteHash), signal: request.signal, cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (stopped || halted) return;
        if (response.status === 401) { stopForInvite(); return; }
        if (response.status === 503 && payload?.code === 'INVITE_NOT_CONFIGURED') { stopForInvite('INVITE_NOT_CONFIGURED'); return; }
        verified = response.ok && payload?.ok === true;
      } catch { /* A connection failure does not invalidate the saved invitation. */ }
      finally { clearTimeout(accessTimer); if (accessRequest === request) accessRequest = null; }
      if (!stopped && !halted) retry = setTimeout(verified ? connect : verifyBeforeReconnect, Math.min(500 * 2 ** retries++, 5000));
    };
    const connect = () => {
      if (stopped || halted) return;
      clearTimeout(retry); ready.current = false;
      setConnection(session.current ? 'resuming' : retries ? 'reconnecting' : 'connecting');
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`, ['witchy-v1', `invite.${inviteHash}`]);
      socket.current = ws; ownedSocket = ws;
      const isCurrent = () => !stopped && !halted && socket.current === ws;
      const finishSession = message => {
        if (!isCurrent()) return;
        halted = true; clearTimeout(handshake); clearTimeout(resumeTimeout); clearTimeout(retry);
        ready.current = false; settleRequests(ws);
        session.current = null; persistSession(null); setHasSession(false); setState(null);
        setError(message || '这个席位已结束，请开启或加入一场新的集会。');
        socket.current = null; ws.close(); setGeneration(value => value + 1);
      };
      handshake = setTimeout(() => { if (isCurrent() && ws.readyState !== WebSocket.OPEN) ws.close(); }, 10000);
      ws.onopen = () => {
        if (!isCurrent()) return ws.close();
        clearTimeout(handshake); checkAI(isCurrent);
        if (session.current) {
          setConnection('resuming');
          ws.send(JSON.stringify({ type: 'resume', requestId: 'resume', inviteHash, payload: session.current }));
          resumeTimeout = setTimeout(() => { if (isCurrent() && !ready.current) ws.close(); }, 8000);
        } else { ready.current = true; retries = 0; setConnection('connected'); }
      };
      ws.onmessage = event => {
        if (!isCurrent()) return;
        let data; try { data = JSON.parse(event.data); } catch { return; }
        const code = String(data.code || '').toUpperCase();
        if (code === 'INVITE_INVALID') return stopForInvite();
        if (code === 'INVITE_NOT_CONFIGURED') return stopForInvite('INVITE_NOT_CONFIGURED');
        if ((data.type === 'error' || data.type === 'session_ended') && TERMINAL_CODES.has(code)) return finishSession(data.message);
        if (data.type === 'session') {
          const incoming = { roomId: data.roomId, playerId: data.playerId, token: data.token };
          if (!Object.values(incoming).every(value => typeof value === 'string' && value)) return;
          if (session.current && (incoming.roomId !== session.current.roomId || incoming.playerId !== session.current.playerId)) return;
          session.current = incoming; persistSession(incoming); setHasSession(true);
        }
        if (data.type === 'state' && data.state) {
          if (session.current && (data.state.id !== session.current.roomId || data.state.me?.id !== session.current.playerId)) return;
          clearTimeout(resumeTimeout); ready.current = true; retries = 0;
          setState(data.state); setConnection('connected');
        }
        if (data.type === 'error' && data.requestId === 'resume') {
          // A temporary resume failure is a reconnect, never an expired identity.
          ready.current = false; setConnection('resuming'); ws.close(); return;
        }
        if (data.type === 'ack' || data.type === 'error') {
          const request = requests.current.get(data.requestId);
          if (request?.ws === ws) {
            clearTimeout(request.timer); requests.current.delete(data.requestId);
            updatePending();
            if (data.type === 'error') setError(data.message || '魔法有些不稳定，请再试一次。');
            request.resolve(data.type === 'ack');
          }
        }
      };
      ws.onclose = event => {
        if (!isCurrent()) return;
        clearTimeout(handshake); clearTimeout(resumeTimeout); ready.current = false; settleRequests(ws);
        socket.current = null;
        if (event.code === 4004) return stopForInvite();
        if (event.code === 4001) { halted = true; setConnection('replaced'); return; }
        setConnection(session.current ? 'resuming' : 'reconnecting');
        // Browsers report a rejected upgrade as 1006, hiding its HTTP status.
        // Revalidate before reconnecting so revoked invitations cannot loop.
        void verifyBeforeReconnect();
      };
      ws.onerror = () => { if (isCurrent()) ws.close(); };
    };
    if (isInviteHash(inviteHash)) connect(); else stopForInvite();
    return () => {
      stopped = true; clearTimeout(retry); clearTimeout(handshake); clearTimeout(resumeTimeout); clearTimeout(accessTimer); healthRequest?.abort(); accessRequest?.abort();
      settleRequests(ownedSocket, false);
      if (socket.current === ownedSocket) { socket.current = null; ready.current = false; }
      ownedSocket?.close();
    };
  }, [generation, inviteHash]);

  const send = useCallback((type, payload = {}) => {
    const ws = socket.current;
    if (!ready.current || ws?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const requestId = `r${++seq.current}`, label = payload.action || type;
    setPending(label); setError('');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const request = requests.current.get(requestId);
        if (!request) return;
        requests.current.delete(requestId); updatePending();
        if (socket.current === ws && ready.current) setError('这次魔法等待得有些久，请稍后重试。');
        resolve(false);
      }, 90000);
      requests.current.set(requestId, { resolve, timer, ws, label });
      try { ws.send(JSON.stringify({ type, requestId, inviteHash, payload })); }
      catch { ws.close(); }
    });
  }, [inviteHash]);
  const action = useCallback((name, payload = {}) => send('action', { action: name, ...payload }), [send]);
  const leave = useCallback(() => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN && ready.current) ws.send(JSON.stringify({ type: 'leave', requestId: `leave-${++seq.current}`, inviteHash }));
    session.current = null; persistSession(null); setHasSession(false); setState(null); setError(''); setPending('');
    socket.current = null; ready.current = false; ws?.close(); setGeneration(value => value + 1);
  }, [inviteHash]);
  const reconnect = useCallback(() => {
    const ws = socket.current; socket.current = null; ready.current = false; ws?.close();
    setConnection(session.current ? 'resuming' : 'connecting'); setError(''); setGeneration(value => value + 1);
  }, []);
  const aiReady = typeof state?.aiReady === 'boolean' ? state.aiReady : healthReady;
  return { state, connection, error, pending, aiReady, healthStatus, restoring: hasSession && !state, send, action, leave, reconnect, clearError: () => setError('') };
}
