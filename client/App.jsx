import React, { useEffect, useRef, useState } from 'react';
import RoundResults from './Results.jsx';
import TurnOverlay from './TurnOverlay.jsx';
import PresentationBoard from './PresentationBoard.jsx';
import WinnerCelebration from './WinnerCelebration.jsx';
import InviteGate from './InviteGate.jsx';
import CoinIcon from './CoinIcon.jsx';
import './round-flow.css';
import useGame from './useGame.js';
import PlayerConnectionMark, { presenceDescription, presenceLabel } from './PlayerStatus.jsx';
import './interaction.css';
import './preparation.css';
import './radiance.css';
import './landing.css';
import { ArrowRight, Check, CircleHelp, Copy, Eye, Flame, LoaderCircle, LockKeyhole, LogOut, Moon, Plus, Radio, RotateCcw, Sparkles, Users, WandSparkles, X } from 'lucide-react';

const TIER = { white: ['寻常', '0–9'], green: ['微光', '10–49'], blue: ['秘藏', '50–199'], purple: ['奇珍', '200–1,999'], gold: ['传说', '2,000–9,999'], red: ['禁忌', '10,000+'] };
const COLORS = ['#bfdca2', '#bfa5e9', '#efbd84', '#87c8d1', '#e79eae', '#d5c56c', '#9bb4ec', '#e4ae79'];
const fmt = n => Number(n ?? 0).toLocaleString('zh-CN');
const WINNER_DISMISSED_KEY = 'witchy-winner-dismissed';
const readDismissedWinners = () => {
  try {
    const value = JSON.parse(sessionStorage.getItem(WINNER_DISMISSED_KEY) || '[]');
    return Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(-64) : [];
  } catch { return []; }
};
function WitchMark({ size = 34, color = 'currentColor' }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M10 35 24 8l8 23 8 6c-9 6-28 6-35-1l5-1Z" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/><path d="m17 26 15 5M25 9l10 6-7 4" stroke={color} strokeWidth="1.5"/><path d="m37 5 1.1 3.9L42 10l-3.9 1.1L37 15l-1.1-3.9L32 10l3.9-1.1L37 5Z" fill={color}/></svg>;
}

function Cauldron({ active = false, small = false, peek = false }) {
  return <div className={`cauldron-art ${active ? 'brewing' : ''} ${small ? 'small' : ''}`} aria-hidden="true">
    <svg className="cauldron-svg" viewBox={peek ? '110 58 320 235' : '0 0 540 410'} fill="none">
      <defs>
        <radialGradient id="glow"><stop stopColor="#c4e5a5" stopOpacity=".16"/><stop offset="1" stopColor="#c4e5a5" stopOpacity="0"/></radialGradient>
        <linearGradient id="body" x1="182" y1="180" x2="368" y2="350" gradientUnits="userSpaceOnUse"><stop stopColor="#484147"/><stop offset=".48" stopColor="#28252e"/><stop offset="1" stopColor="#17151d"/></linearGradient>
        <linearGradient id="liquid" x1="194" y1="180" x2="345" y2="213" gradientUnits="userSpaceOnUse"><stop stopColor="#d5eaa5"/><stop offset="1" stopColor="#789b62"/></linearGradient>
        <linearGradient id="fire" x1="270" y1="315" x2="270" y2="375" gradientUnits="userSpaceOnUse"><stop stopColor="#e4c482"/><stop offset="1" stopColor="#997051" stopOpacity=".25"/></linearGradient>
        <radialGradient id="afternoon-sun" cx="0" cy="0" r="1" gradientTransform="translate(102 34) rotate(45) scale(290 215)" gradientUnits="userSpaceOnUse"><stop stopColor="#f5dc9b" stopOpacity=".24"/><stop offset=".42" stopColor="#d5cd89" stopOpacity=".1"/><stop offset="1" stopColor="#b8c782" stopOpacity="0"/></radialGradient>
        <linearGradient id="sun-shaft" x1="95" y1="3" x2="342" y2="357" gradientUnits="userSpaceOnUse"><stop stopColor="#fff0bb" stopOpacity=".4"/><stop offset=".42" stopColor="#e4d89c" stopOpacity=".17"/><stop offset="1" stopColor="#dfd99c" stopOpacity="0"/></linearGradient>
        <radialGradient id="grass-ground"><stop stopColor="#698c46" stopOpacity=".4"/><stop offset=".65" stopColor="#466535" stopOpacity=".19"/><stop offset="1" stopColor="#324c2d" stopOpacity="0"/></radialGradient>
        <linearGradient id="grass-blade" x1="270" y1="295" x2="270" y2="380" gradientUnits="userSpaceOnUse"><stop stopColor="#aecb77"/><stop offset="1" stopColor="#39573a" stopOpacity=".25"/></linearGradient>
        <filter id="shaft-softness" x="-35%" y="-25%" width="170%" height="150%"><feGaussianBlur stdDeviation="4"/></filter>
      </defs>
      <g className="cauldron-environment">
      <ellipse cx="270" cy="220" rx="265" ry="205" fill="url(#afternoon-sun)"/>
      <g className="cauldron-sunbeams" filter="url(#shaft-softness)">
        <path d="M55-12h21l215 376-79-28Z" fill="url(#sun-shaft)"/>
        <path d="M103-5h12l257 380-43-11Z" fill="url(#sun-shaft)"/>
        <path d="M133-8h28l297 361-82 1Z" fill="url(#sun-shaft)" opacity=".65"/>
      </g>
      <g className="cauldron-meadow">
        <ellipse cx="274" cy="351" rx="226" ry="66" fill="url(#grass-ground)"/>
        <g stroke="url(#grass-blade)" strokeLinecap="round" strokeWidth="2.4" opacity=".8">
          <path d="M89 350q-8-17-4-34m9 39q1-30 15-44m-9 43q12-17 25-20M123 367q-7-28-20-35m22 33q2-24 15-39m-4 43q12-19 25-21M166 381q-5-23-20-38m21 37q2-25 11-35M376 368q-2-30-16-47m16 48q9-31 22-42m-9 47q9-19 25-23M420 353q-2-33 11-48m-9 48q13-21 28-27m-18 31q16-17 29-20M349 383q5-18 17-27M201 385q-1-18-12-26"/>
        </g>
        <g fill="#8eaf66" opacity=".5"><path d="M111 352q-28-18-31-6 18 10 31 6M404 357q26-25 32-13-14 15-32 13M150 375q-20-17-25-7 12 10 25 7"/></g>
      </g>
      <circle cx="270" cy="207" r="200" fill="url(#glow)"/>
      <ellipse cx="270" cy="218" rx="196" ry="164" stroke="#c4b58b" strokeOpacity=".17" strokeDasharray="2 9"/>
      <ellipse cx="270" cy="218" rx="174" ry="147" stroke="#c4b58b" strokeOpacity=".12"/>
      <path d="M270 35v22m0 321v-18M63 218h22m370 0h22" stroke="#c4b58b" strokeOpacity=".3"/>
      <g className="float-one"><path d="m120 99 5 13 14 5-14 5-5 14-5-14-14-5 14-5 5-13Z" fill="#c0d39b"/><path d="m402 276 3 8 8 3-8 3-3 8-3-8-8-3 8-3 3-8Z" fill="#c0d39b"/></g>
      <g className="float-two"><circle cx="397" cy="116" r="11" fill="#e1cc8f" fillOpacity=".15" stroke="#e1cc8f" strokeOpacity=".65"/><path d="M397 96v-4m0 48v-4m-20-20h-4m48 0h-4m-34-14-3-3m34 34-3-3m-28 0-3 3m34-34-3 3" stroke="#e1cc8f" strokeOpacity=".45" strokeLinecap="round"/><circle cx="128" cy="274" r="3" fill="#c3b48d"/><circle cx="364" cy="78" r="2" fill="#c3b48d"/></g>
      </g>
      <g className="steam"><path d="M232 159c-26-31 26-35 2-69M268 144c-27-28 34-40 4-76M305 157c24-28-19-34 2-61" stroke="#c4e5a5" strokeOpacity=".26" strokeWidth="2" strokeLinecap="round"/></g>
      <g className="bubbles"><circle cx="246" cy="153" r="5" stroke="#bfd69c"/><circle cx="290" cy="127" r="7" stroke="#bfd69c" strokeOpacity=".6"/><circle cx="316" cy="166" r="3" fill="#bfd69c"/><circle cx="258" cy="104" r="2" fill="#bfd69c"/></g>
      <ellipse cx="270" cy="361" rx="113" ry="14" fill="#0c0a11" fillOpacity=".5"/>
      <g className="fire"><path d="M233 350c-3-17 7-27 14-38 1 15 14 18 10 33 1-22 15-27 14-44 20 22 10 30 18 43-2-19 8-20 10-30 13 15 18 24 8 39Z" fill="url(#fire)"/></g>
      <path d="m213 320-11 29m126-29 11 29" stroke="#4e4344" strokeWidth="12" strokeLinecap="round"/>
      <path d="M170 222c-52-30-54 49-10 45m210-45c52-30 54 49 10 45" stroke="#4b444e" strokeWidth="13"/>
      <path d="M171 209c-41 64-15 132 99 133s141-67 99-133Z" fill="url(#body)" stroke="#655763" strokeWidth="1.5"/>
      <path d="M181 242c-9 34 7 54 31 67" stroke="#fff" strokeOpacity=".08" strokeWidth="8" strokeLinecap="round"/>
      <ellipse cx="270" cy="208" rx="105" ry="32" fill="#1b1821" stroke="#71606e" strokeWidth="7"/>
      <ellipse cx="270" cy="208" rx="94" ry="24" fill="url(#liquid)"/>
      <path d="M186 207c21-14 33 11 56-2s38 12 59-1 35 6 51 0" stroke="#edf6ca" strokeOpacity=".6" strokeWidth="2"/>
      <ellipse cx="238" cy="211" rx="12" ry="4" stroke="#eff9cb" strokeOpacity=".55"/><ellipse cx="303" cy="198" rx="7" ry="3" fill="#e0edb1"/>
      <path d="M279 264c-18-2-29 16-18 28 7 9 20 7 25-2-11 3-19-10-7-26Z" fill="#b7a57c" fillOpacity=".9"/>
      <path d="m293 273 2 5 5 2-5 1-2 6-1-6-6-1 6-2 1-5Z" fill="#b7a57c"/>
      <path d="m321 185 35-70" stroke="#7b624d" strokeWidth="8" strokeLinecap="round"/><path d="m322 183 33-67" stroke="#b19672" strokeWidth="2" strokeLinecap="round"/>
      <g opacity=".65" stroke="#c0ad83"><path d="m155 330 8 3m-38-140 8-3m236 136 8-3"/><circle cx="160" cy="171" r="2"/><circle cx="370" cy="252" r="2"/></g>
    </svg>
  </div>;
}

function Header({ game, onRules }) {
  const { state, connection, aiReady, healthStatus } = game;
  const aiStatus = aiReady === true ? '下午茶冒出热气，聚会随时可以开始' : aiReady === false ? '未能连接到服务器' : healthStatus === 'unavailable' ? '未能连接到服务器' : '正在连接服务器中';
  return <header className="site-header">
    <a className="brand" href="/" onClick={e => { if (state) e.preventDefault(); }}><span className="brand-mark"><WitchMark /></span><span><strong>女巫的聚会<span className="brand-dot">✦</span></strong><small>WITCHY PARTY</small></span></a>
    <div className="header-center">A LITTLE SUNSHINE. A LITTLE MAGIC.</div>
    <div className="header-actions">
      <span className={`connection ${connection === 'connected' && aiReady === true ? 'online' : ''}`} role="status">
        <i />
        {connection === 'connected' ? aiStatus : connection === 'replaced' ? '席位已在另一页面打开' : game.restoring || state ? '正在回到房间…' : '正在连接集会…'}
      </span>
      <button className="icon-button help-button" aria-label="查看游戏规则" title="游戏规则" onClick={onRules}><CircleHelp size={19}/></button>
    </div>
  </header>;
}

function AIConnectionNotice({ game }) {
  if (game.aiReady === true) return null;
  const checking = game.aiReady == null && game.healthStatus === 'checking';
  return <p className="ai-connection-notice" role="status">{checking ? <LoaderCircle size={14} className="spin"/> : <Sparkles size={14}/>}<span>{game.aiReady === false ? '尚未连接 DeepSeek，配置后即可开始集会' : checking ? '正在检查 DeepSeek 配置…' : '暂时无法确认 DeepSeek 配置，请稍后重试'}</span></p>;
}

function Landing({ game }) {
  const [tab, setTab] = useState('create'), [name, setName] = useState(''), [roomId, setRoomId] = useState(''), [rounds, setRounds] = useState(3);
  const disabled = !!game.pending || game.connection !== 'connected';
  const submit = e => {
    e?.preventDefault();
    const witchName = name.trim() || '月光女巫';
    game.send(tab === 'join' ? 'join' : 'create', { name: witchName, rounds, roomId: roomId.trim().toUpperCase() });
  };
  return <main className="landing landing-compact">
      <section className="entry-card landing-entry-card" aria-labelledby="landing-title">
        <div className="landing-cauldron" aria-hidden="true"><Cauldron peek/></div>
        <div className="landing-entry-heading"><h1 id="landing-title">女巫的聚会</h1><p>今天来点魔法</p></div>
        <div className="segmented" role="tablist" aria-label="进入方式"><button role="tab" aria-selected={tab === 'create'} className={tab === 'create' ? 'selected' : ''} onClick={() => setTab('create')}>开启一场集会</button><button role="tab" aria-selected={tab === 'join'} className={tab === 'join' ? 'selected' : ''} onClick={() => setTab('join')}>加入朋友</button></div>
        <form onSubmit={submit}><label htmlFor="witch-name">女巫昵称 <span>你的神秘代号</span></label><div className="input-wrap"><WandSparkles size={17}/><input id="witch-name" value={name} onChange={e => setName(e.target.value)} maxLength={16} placeholder="月光女巫" autoComplete="nickname"/></div>
          {tab === 'create' ? <><label>出牌轮数</label><div className="round-selector">{[3, 5, 10].map(n => <button type="button" key={n} onClick={() => setRounds(n)} className={rounds === n ? 'selected' : ''}><strong>{n}</strong> 轮<small>{n === 3 ? '小试魔法' : n === 5 ? '渐入佳境' : '尽兴相聚'}</small></button>)}</div></> : <><label htmlFor="room-code">房间码</label><input id="room-code" className="code-input" required minLength={4} maxLength={12} value={roomId} onChange={e => setRoomId(e.target.value.toUpperCase())} placeholder="输入朋友的房间码" autoComplete="off"/></>}
          <button className="button primary full" disabled={disabled} type="submit">{game.pending ? <LoaderCircle className="spin" size={17}/> : <Sparkles size={17}/>} {tab === 'create' ? '开启一场集会' : '加入这场集会'}<ArrowRight size={17}/></button>
        </form>
        {game.error && <div className="landing-error" role="alert"><span>{game.error}</span><button className="icon-button" onClick={game.clearError} aria-label="关闭提示"><X size={15}/></button></div>}
        {game.connection !== 'connected' ? <p className="landing-connection" role="status"><LoaderCircle className="spin" size={14}/>正在连接集会…</p> : <AIConnectionNotice game={game}/>}
        <p className="entry-footnote"><LockKeyhole size={12}/>私密房间 · 分享房间码即可加入</p>
      </section>
  </main>;
}

function Avatar({ player, index = 0, large = false }) {
  return <div className={`avatar ${large ? 'large' : ''} ${player?.connected === false ? 'is-disconnected' : ''}`} style={{ '--avatar-color': COLORS[index % COLORS.length] }}><WitchMark size={large ? 38 : 29}/>{player?.bot && <span className="bot-dot">✦</span>}<PlayerConnectionMark player={player}/></div>;
}

function RoomLobby({ game }) {
  const s = game.state, isHost = s.hostId === s.me.id;
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(s.id); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} };
  return <main className="room-lobby"><div className="room-intro"><span className="eyebrow">THE GATHERING</span><h1>茶点准备好了，<br/><em>等朋友入座。</em></h1><p>开局 20,000 金币，带着每轮收获继续下一锅。<br/>邀请朋友一起加入今天的炼金派对。</p><div className="invite-box"><div><small>房间码</small><strong>{s.id}</strong></div><button className="button ghost" onClick={copy}>{copied ? <Check size={17}/> : <Copy size={17}/>} {copied ? '已复制' : '复制房间码'}</button></div><div className="room-meta"><span><Users size={16}/> {s.players.length} / 8 位女巫</span><span><Moon size={16}/> {s.totalRounds} 轮出牌</span></div><Cauldron small/></div><section className="gathering-panel"><div className="panel-heading"><span className="tiny-label">THE COVEN</span><span className="pill"><i/>等待开始</span></div><h2>今天的女巫们</h2><div className="seat-list">{s.players.map((p, i) => <div className={`seat ${p.connected === false ? 'is-disconnected' : ''}`} key={p.id}><Avatar player={p} index={i}/><span><strong>{p.name}{p.id === s.me.id && <em>你</em>}</strong><small>{presenceDescription(p) || (p.bot ? '由 DeepSeek 驱动的 AI 女巫' : '已经准备好分享灵感')}</small></span><span className={`seat-badge ${p.id === s.hostId ? 'host' : ''}`}>{presenceLabel(p) || (p.id === s.hostId ? '房主' : p.bot ? 'AI' : '已入座')}</span></div>)}{s.players.length < 8 && <div className="seat empty-seat"><div className="empty-avatar"><Plus size={20}/></div><span>留一个位置，给有趣的灵魂。<small>分享房间码，朋友即可加入</small></span></div>}</div>{isHost && s.players.length < 8 && <button className="button ghost full" disabled={!!game.pending || game.aiReady !== true || game.connection !== 'connected'} onClick={() => game.action('addBot')}><Plus size={16}/>添加 AI 女巫</button>}<AIConnectionNotice game={game}/><div className="gathering-bottom"><p><LockKeyhole size={14}/>依次投料，投入价值最高者赢得反应后的整锅金币。</p>{isHost ? <button className="button primary full" disabled={s.players.length < 2 || !!game.pending || game.aiReady !== true || game.connection !== 'connected'} onClick={() => game.action('start')}><Flame size={17}/>开始今天的集会<ArrowRight size={17}/></button> : <div className="waiting-host"><LoaderCircle size={16} className="spin"/>等待房主开始集会</div>}<button className="text-button leave-button" onClick={game.leave}><LogOut size={14}/>离开集会</button></div></section></main>;
}

function GatheringPlayers({ state, avatarRefs, presentationComplete }) {
  return <div className="gathering-players" aria-label="本轮随机座次">{state.players.map((player, index) => <div className={`gathering-player ${player.ready ? 'is-ready' : ''} ${player.connected === false ? 'is-disconnected' : ''} ${player.status === 'eliminated' ? 'is-eliminated' : ''} ${state.phase === 'performing' && player.id === state.presentation?.playerId ? 'is-performing' : ''}`} key={player.id} data-player-id={player.id}><div className="circle-avatar" ref={node => { if (node) avatarRefs.current.set(player.id, node); else avatarRefs.current.delete(player.id); }}><Avatar player={player} index={index}/>{state.phase === 'preparing' && player.ready && <span className="avatar-ready-check"><Check size={11}/></span>}</div><strong>{player.name}{player.id === state.me.id && <em>你</em>}</strong><small>{presenceDescription(player) || (player.status === 'eliminated' ? '金币归零 · 旁观中' : state.phase === 'preparing' ? player.ready ? '准备好了' : '正在构想材料' : state.phase === 'performing' && player.id === state.presentation?.playerId ? state.presentation.kind === 'deposit' ? presentationComplete ? '已投入' : '灵感正在入锅' : presentationComplete ? '反应完成' : '材料正在反应' : `本轮座次 ${index + 1}`)}</small></div>)}</div>;
}

function GameBoard({ game, celebration, onContinue }) {
  const s = game.state, self = s.players.find(player => player.id === s.me.id), [copied, setCopied] = useState(false);
  const [presentationStatus, setPresentationStatus] = useState({ key: null, completed: false });
  const preparing = s.phase === 'preparing', resolving = s.phase === 'resolving', performing = s.phase === 'performing';
  const avatarRefs = useRef(new Map()), playing = self?.status === 'active';
  const presentationKey = s.presentation && `${s.presentation.id}:${s.presentation.index}:${s.presentation.startedAt}`;
  const presentationComplete = presentationStatus.key === presentationKey && presentationStatus.completed;
  const copy = async () => { try { await navigator.clipboard.writeText(s.id); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {} };
  return <><main className="tea-game coin-game"><div className="tea-game-top"><div className="tea-round"><span>第 <b>{s.round}</b> / {s.totalRounds} 轮出牌</span><small>每轮重新洗牌 · 全员同时准备</small></div><div className="private-budget"><div><small>你的金币</small><strong className={s.me.coins < 0 ? 'negative' : ''}><CoinIcon size={23}/>{fmt(s.me.coins)}</strong></div><span className="budget-total">余额跨轮保留</span></div><button className="tea-room-code" onClick={copy} title="复制房间码">{s.id}{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div><GatheringPlayers state={s} avatarRefs={avatarRefs} presentationComplete={presentationComplete}/>
    {self?.status === 'eliminated' && <div className="eliminated-notice"><Eye size={16}/><span>金币已归零，你可以继续旁观。</span></div>}
    <section className={`round-stage ${resolving ? 'is-awaiting' : ''} ${performing ? 'is-performing' : ''}`} aria-label={resolving ? '等待材料入锅' : performing ? '投料与材料反应演出' : '等待全员准备'}><div className="round-stage-heading"><span className="tiny-label">{performing ? 'ONE LITTLE WONDER AFTER ANOTHER' : 'A LITTLE PATIENCE, A LITTLE MAGIC'}</span><h1>{resolving ? '材料准备好了，稍等片刻。' : performing ? s.presentation?.kind === 'reaction' ? '看，新的灵感诞生了。' : '一份灵感，飞进这一锅。' : '女巫们正在准备这一锅。'}</h1><p>{resolving ? '每份材料入锅时，名称与金币价格会一起出现。' : performing ? '每一份材料，都有属于它的奇妙时刻。' : '每人选好一张材料，全员准备好后依次投入。'}</p></div>
      {resolving && !s.processingError && <div className="round-awaiting" role="status"><span><Sparkles size={27}/><LoaderCircle className="spin" size={57} strokeWidth={1}/></span><strong>正在准备这一锅</strong><p>女巫们的灵感，马上就要相遇。</p></div>}
      {s.processingError && <div className="round-retry" role="alert"><p>{s.processingError}</p>{s.hostId === s.me.id ? <button className="button ghost" disabled={!!game.pending || s.busy || game.connection !== 'connected'} onClick={() => game.action('retryCommit')}><RotateCcw size={14}/>重试反应</button> : <small>等待房主重试</small>}</div>}
      {performing && <PresentationBoard state={s} avatarRefs={avatarRefs} onProgressState={setPresentationStatus}/>}
      {preparing && !playing && <div className="spectator-preparing"><Cauldron small/><p>{s.players.filter(player => player.ready).length} / {s.players.filter(player => player.status === 'active').length} 位女巫已准备</p></div>}
    </section><div className="tea-game-footer"><span><Radio size={13}/>炉边小记</span><p>{s.log?.at(-1)?.text || '每份灵感都有自己的价码。'}</p><button className="text-button" onClick={game.leave}><LogOut size={13}/>离开集会</button></div>{preparing && playing && <TurnOverlay key={`${s.round}-${s.me.id}`} game={game}/>}</main>
    {celebration && <WinnerCelebration key={celebration.id} celebration={celebration} serverTime={s.serverTime} avatarRefs={avatarRefs} onContinue={onContinue} renderAvatar={winner => <Avatar player={{ ...winner, connected: true, status: 'active' }} index={winner.avatarIndex ?? Math.max(0, s.players.findIndex(player => player.id === winner.id))} large/>}/>}</>;
}

function Rules({ close }) {
  const closeRef = useRef(null);
  useEffect(() => { closeRef.current?.focus(); const key = event => { if (event.key === 'Escape') close(); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [close]);
  return <div className="modal-overlay" onClick={close}><section className="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={event => event.stopPropagation()}><button ref={closeRef} className="icon-button modal-close" onClick={close} aria-label="关闭规则"><X size={20}/></button><span className="eyebrow">THE WITCH’S HANDBOOK</span><h2 id="rules-title">午后集会的小约定</h2><p className="rules-lead">一点想象力，一点胆量，剩下的交给坩埚。</p><ol className="rule-list"><li><strong>带上金币与灵感</strong><p>每人开局获得一次 20,000 金币，余额跨轮保留。选择 3、5 或 10 轮出牌；每一轮都会重新随机安排座次。</p></li><li><strong>一起准备，依次投料</strong><p>每轮最多构想 3 份材料，选择其中一张准备。全员准备好前可以重新选择；全员就绪后一次扣除各自投入，随后按当轮座次投料。每份材料的名称和金币价格随它入锅时出现。</p></li><li><strong>搅拌一锅可能</strong><p>材料按当轮座次入锅，可能发生意想不到的反应。原始投入价值最高的女巫，获得反应后整锅价值的金币奖励；原始投入价值相同则随机决定。</p></li><li><strong>每轮直接看收获</strong><p>看完投料与连锁反应后，先揭晓本轮赢家，点击后查看排行榜和金币变化。允许透支投入；结算奖励后金币仍不大于 0 的女巫失败，金币归零，之后可以旁观。</p></li><li><strong>带着余额继续</strong><p>只剩一位未失败、未离场的女巫时，立即赢得整场集会。否则完成约定出牌轮数，按金币余额排名。</p></li></ol><div className="rules-tiers">{Object.entries(TIER).map(([tier, [label, range]]) => <div className={`tier-${tier}`} key={tier}><i/><strong>{label}</strong><span>{range} 金币</span></div>)}</div><p className="rules-footnote">还有后续反应时，中间停留约 1 秒；单次投料或整串反应完成后，停留约 1.5 秒，再由下一位女巫投料。</p><button className="button primary full" onClick={close}>记住了，开炼。<Sparkles size={16}/></button></section></div>;
}

function RejoiningRoom({ game }) {
  const replaced = game.connection === 'replaced';
  return <main className="rejoining-room" role="status"><div className="rejoining-symbol"><WitchMark size={42}/>{!replaced && <LoaderCircle className="spin" strokeWidth={1}/>}</div><h1>{replaced ? '你的席位已在另一页面打开' : '正在回到房间'}</h1><p>{replaced ? '可以继续使用那个页面，也可以把席位切回这里。' : '正在确认你的席位并恢复这场集会。'}</p>{replaced && <button className="button ghost" onClick={game.reconnect}><RotateCcw size={15}/>在此页面重新连接</button>}</main>;
}

function GameApp({ inviteHash, onInviteInvalid }) {
  const game = useGame({ inviteHash, onInviteInvalid }), [rules, setRules] = useState(false);
  const [dismissedWinners, setDismissedWinners] = useState(readDismissedWinners);
  const lastGameState = useRef(null);
  const returning = game.restoring || game.connection === 'replaced';
  const landing = !game.state && !returning;
  const resultState = game.state && ['roundEnd', 'finished'].includes(game.state.phase);
  const candidate = resultState && game.state.roundResult?.winnerCelebration;
  const celebration = !returning && candidate?.backdrop && !dismissedWinners.includes(candidate.id) ? candidate : null;
  if (game.state && ['preparing', 'resolving', 'performing'].includes(game.state.phase)) lastGameState.current = game.state;
  else if (!game.state || game.state.phase === 'lobby') lastGameState.current = null;
  const previousState = lastGameState.current?.id === game.state?.id && lastGameState.current?.round === game.state?.round ? lastGameState.current : game.state;
  const boardGame = celebration ? { ...game, state: { ...previousState, phase: 'performing', presentation: celebration.backdrop, pot: celebration.backdrop.potAfter || game.state.pot, serverTime: Math.max(game.state.serverTime || Date.now(), Number(celebration.backdrop.startedAt) + Number(celebration.backdrop.durationMs)) } } : game;
  const continueToRanking = () => {
    if (!celebration) return;
    const next = [...dismissedWinners.filter(id => id !== celebration.id), celebration.id].slice(-64);
    setDismissedWinners(next);
    try { sessionStorage.setItem(WINNER_DISMISSED_KEY, JSON.stringify(next)); } catch {}
  };
  useEffect(() => { if (celebration || landing) setRules(false); }, [celebration?.id, landing]);
  return <div className={`app-shell${landing ? ' is-landing' : ''}`} inert={celebration ? true : undefined} aria-hidden={celebration ? true : undefined}>{!landing && <Header game={game} onRules={() => setRules(true)}/>} {!landing && game.error && <div className="error-toast" role="alert"><span>{game.error}</span><button className="icon-button" onClick={game.clearError} aria-label="关闭提示"><X size={16}/></button></div>}{game.state && !returning && game.connection !== 'connected' && <div className="room-reconnect-banner" role="status"><LoaderCircle size={15} className="spin"/>正在回到房间，请稍候。</div>}<div className="room-content">{returning ? <RejoiningRoom game={game}/> : !game.state ? <Landing game={game}/> : game.state.phase === 'lobby' ? <RoomLobby game={game}/> : resultState && !celebration ? <RoundResults game={game}/> : <GameBoard game={boardGame} celebration={celebration} onContinue={continueToRanking}/>}</div> {!landing && rules && <Rules close={() => setRules(false)}/>}</div>;
}

export default function App() {
  return <InviteGate artwork={<div className="landing-cauldron" aria-hidden="true"><Cauldron peek/></div>}>{access => <GameApp key={access.inviteHash} {...access}/>}</InviteGate>;
}
