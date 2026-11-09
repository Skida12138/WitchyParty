import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, LockKeyhole, LogOut, Plus, RotateCcw, Sparkles, X } from 'lucide-react';
import CoinIcon from './CoinIcon.jsx';
import { DisconnectedPlayers } from './PlayerStatus.jsx';

const fmt = value => Number(value ?? 0).toLocaleString('zh-CN');
const qualities = { white: '寻常', green: '微光', blue: '秘藏', purple: '奇珍', gold: '传说', red: '禁忌' };

export default function TurnOverlay({ game }) {
  const s = game.state, me = s.me;
  const waiting = !!me.preparedQuoteId;
  const canReselect = s.phase === 'preparing' && !!me.preparedQuoteId;
  const canRetry = me.id === s.hostId || me.id === s.turnPlayerId;
  const [shown, setShown] = useState(me.quotes || []), [selected, setSelected] = useState(null);
  const [dialog, setDialog] = useState(false), [name, setName] = useState(''), [pricing, setPricing] = useState(false), [localError, setLocalError] = useState('');
  const [departingPlaceholder, setDepartingPlaceholder] = useState(false);
  const pricingRef = useRef(false), latestQuotes = useRef(me.quotes || []), mounted = useRef(true), inputRef = useRef(null), cardRefs = useRef(new Map()), positions = useRef(new Map()), actionRef = useRef(null), overlayRef = useRef(null), dialogRef = useRef(null);
  latestQuotes.current = me.quotes || [];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = oldOverflow; };
  }, []);
  useEffect(() => {
    if (!dialog) return;
    if (!pricing) inputRef.current?.focus({ preventScroll: true });
    const onKey = event => {
      if (event.key === 'Escape' && !pricing && !event.isComposing && dialogRef.current?.contains(event.target)) { event.preventDefault(); setDialog(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, pricing]);
  useEffect(() => { if (!pricingRef.current) setShown(me.quotes || []); }, [me.quotes]);
  useEffect(() => { if (selected) actionRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' }); }, [selected]);
  useLayoutEffect(() => {
    const next = new Map();
    for (const [id, node] of cardRefs.current) {
      const current = node.getBoundingClientRect(); next.set(id, current);
      const previousCard = positions.current.get(id);
      const emergingFromPlaceholder = !previousCard && id !== 'placeholder' && shown.length < 3;
      const old = previousCard || (emergingFromPlaceholder ? positions.current.get('placeholder') : null);
      if (old && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && (old.left !== current.left || old.top !== current.top)) node.animate([{ transform: `translate(${old.left - current.left}px,${old.top - current.top}px)`, ...(emergingFromPlaceholder ? { opacity: 0 } : {}) }, { transform: 'translate(0,0)', ...(emergingFromPlaceholder ? { opacity: 1 } : {}) }], { duration: 650, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
    positions.current = next;
  }, [shown.length, departingPlaceholder]);
  const busy = pricing || !!game.pending || me.quoteBusy || game.connection !== 'connected';
  const selectedId = me.preparedQuoteId || selected;
  const chosen = shown.find(q => q.id === selectedId), canImagine = shown.length < (s.rules?.maxQuotes || 3);
  const inspect = async e => {
    e.preventDefault();
    if (!name.trim() || busy || waiting || pricingRef.current) return;
    pricingRef.current = true; setPricing(true); setLocalError('');
    const started = performance.now();
    const ok = await game.action('quote', { name: name.trim() });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1500 - (performance.now() - started))));
    if (!mounted.current) return;
    pricingRef.current = false; setPricing(false);
    if (ok) {
      const next = latestQuotes.current;
      if (next.length >= (s.rules?.maxQuotes || 3)) { setDepartingPlaceholder(true); setTimeout(() => { if (mounted.current) setDepartingPlaceholder(false); }, 650); }
      setShown(next); setDialog(false); setName(''); setSelected(null);
    } else setLocalError('这份材料暂时未能召唤，请调整名称后再试一次。');
  };
  const attach = key => node => node ? cardRefs.current.set(key, node) : cardRefs.current.delete(key);
  return <div ref={overlayRef} tabIndex={-1} className={`turn-overlay ${waiting ? 'turn-overlay-waiting' : ''}`} role="region" aria-labelledby="turn-title">
    <div className="turn-overlay-toolbar"><span>第 {s.round} / {s.totalRounds} 轮出牌</span><button className="text-button" onClick={game.leave}><LogOut size={13}/>离开集会</button></div><div className="turn-overlay-content"><div className="turn-eyebrow"><Sparkles size={14}/>所有人一起准备材料</div><h1 id="turn-title">你要往坩埚里放什么？</h1><p className="turn-subtitle">各自选好一张材料。全员准备好后，依次投料并展开反应。</p><p className="preparing-presence" role="status">已有 <strong>{s.players.filter(player => player.status === 'active' && player.ready).length} / {s.players.filter(player => player.status === 'active').length}</strong> 位女巫准备好</p>
      <DisconnectedPlayers players={s.players}/>
      <div className="turn-private-budget"><span><LockKeyhole size={12}/>材料尚未公开</span><span>剩余金币 <b>{fmt(me.coins)}</b><CoinIcon size={15}/></span><span>余额跨轮保留</span></div>
      <div className="imagination-area">
      <div className={`imagination-cards cards-count-${shown.length} ${waiting ? 'imagination-cards-waiting' : ''}`} inert={waiting ? true : undefined} aria-hidden={waiting ? true : undefined}>
        {shown.map((q, i) => <button ref={attach(q.id)} className={`quality-card tier-${q.tier} ${selectedId === q.id ? 'selected' : ''}`} style={{ '--card-index': i }} key={q.id} disabled={busy || waiting} onClick={() => setSelected(q.id)} aria-pressed={selectedId === q.id} aria-label={`选择${q.name}，消耗${fmt(q.price)}金币`}>{q.tier === 'red' && <span className="ruby-aura" aria-hidden="true"/>}<span className="quality-corner top-left">✦</span><span className="quality-corner bottom-right">✦</span><span className="quality-name">{qualities[q.tier] || '未知'}品质</span><span className="quality-symbol">{['✧', '❋', '✦'][i % 3]}</span><strong>{q.name}</strong><span className="quality-price" data-wide={fmt(q.price).length > 8}><CoinIcon size={24}/>{fmt(q.price)}</span><span className="quality-check"><Check size={15}/></span></button>)}
        {canImagine && <button ref={attach('placeholder')} className="imagination-placeholder" disabled={busy || waiting} aria-label="想一份材料" onClick={() => { setLocalError(''); setDialog(true); }}><span className="placeholder-plus"><Plus size={31} strokeWidth={1}/></span><strong>{shown.length ? '再想一种可能' : '想一份材料'}</strong><small>{shown.length ? `还可以想 ${Math.max(0, (s.rules?.maxQuotes || 3) - shown.length)} 次` : '点击，把灵感变成材料'}</small></button>}
        {departingPlaceholder && <div className="imagination-placeholder placeholder-departing" aria-hidden="true"><Plus size={30}/></div>}
      </div>
      {waiting && <div className="preparation-waiting-overlay" role="status"><LoaderCircle size={22} className={s.processingError ? '' : 'spin'}/><strong>正在等待其他女巫</strong></div>}
      </div>
      <p className="imagination-count" aria-live="polite">已召唤 {shown.length} / {s.rules?.maxQuotes || 3}<span>·</span>还可更改灵感 {Math.max(0, (s.rules?.maxQuotes || 3) - shown.length)} 次</p>
      <div className="turn-selection-area" ref={actionRef}>{waiting ? <div className="preparation-wait-actions"><p>{chosen ? <>「<strong>{chosen.name}</strong>」已经准备好了。</> : '你的材料已经准备好了。'}</p>{canReselect ? <><button className="button ghost" disabled={busy} onClick={() => game.action('unready')}><RotateCcw size={15}/>重新选择</button><small>全员准备好前，可以重新选择材料。</small></> : s.processingError ? <section className="preparation-wait-recovery" role="alert"><strong>这份材料暂时没有成功投入</strong><p>{s.processingError}</p>{canRetry ? <button className="button ghost" disabled={busy || s.busy} onClick={() => game.action('retryCommit')}><RotateCcw size={15}/>重试投入</button> : <small>等待房主或当前女巫重试</small>}</section> : <small>全员已准备好，稍后一起观看材料的变化。</small>}</div> : chosen ? <div className="chosen-confirmation"><p>这一轮，就准备「<strong>{chosen.name}</strong>」吧。</p><div className="chosen-account"><span>本次消耗 <b>{fmt(chosen.price)}</b><CoinIcon size={14}/></span><span>全员就绪后余额 <b>{fmt(me.coins - chosen.price)}</b><CoinIcon size={14}/></span></div><p className={chosen.price >= me.coins ? "over-budget-warning" : "budget-guidance"}>{chosen.price >= me.coins ? `${chosen.price > me.coins ? '可以透支投入' : '这份材料会用完金币'}；结算奖励后金币仍不大于 0，就会失败并归零` : '准备阶段不扣金币；最高原始投入赢得整锅奖励'}</p><button className="button primary confirm-material" disabled={busy} onClick={() => game.action('commit', { quoteId: chosen.id })}>准备好了<Check size={17}/></button><small>全员就绪时扣除金币；在这之前可以重新选择。</small></div> : <p className="choose-hint">{shown.length ? '选择一张材料卡，准备开始这场小小的冒险。' : '一片云、一句悄悄话，或一块会唱歌的饼干。'}<span>开局 {fmt(s.rules?.startingCoins || 20000)} 金币 · 每轮最多构想 {s.rules?.maxQuotes || 3} 份材料</span></p>}</div>
      {me.quoteBusy && !pricing && <div className="restore-pricing"><LoaderCircle size={15} className="spin"/>正在召唤材料</div>}
    </div>
    {dialog && <div className="imagination-dialog-backdrop" onClick={() => { if (!pricing) setDialog(false); }}><section ref={dialogRef} tabIndex={-1} className="imagination-dialog" role="dialog" aria-modal="false" aria-labelledby="imagination-title" onClick={e => e.stopPropagation()}>{!pricing && <button className="icon-button dialog-close" aria-label="关闭材料输入" onClick={() => setDialog(false)}><X size={19}/></button>}{pricing ? <div className="summoning-inspection" role="status"><div className="summoning-spinner"><Sparkles size={29}/><LoaderCircle size={63} strokeWidth={1} className="spin"/></div><h2 id="imagination-title">正在召唤材料</h2><p>给灵感一点时间，让奇妙慢慢发生。</p></div> : <><span className="dialog-star">✧</span><h2 id="imagination-title">你想到了什么？</h2><form onSubmit={inspect}><label htmlFor="imagined-material">材料名称</label><input ref={inputRef} id="imagined-material" maxLength={80} autoComplete="off" placeholder="例如：一片被阳光晒暖的月亮" value={name} onChange={e => setName(e.target.value)}/><small className="material-input-tip">召唤一份灵感，全员就绪时才会消耗金币。</small>{(localError || game.error) && <p className="material-rejection" role="alert">{game.error || localError}</p>}<button className="button primary full" type="submit" disabled={busy || !name.trim()}><Sparkles size={16}/>召唤这份材料</button></form><small>一份好材料，也许就藏在你刚才的奇思妙想里。</small></>}</section></div>}
  </div>;
}
