import React from 'react';
import { ArrowRight, Check, Eye, LoaderCircle, LogOut, Trophy } from 'lucide-react';
import CoinIcon from './CoinIcon.jsx';
import { presenceLabel } from './PlayerStatus.jsx';

const fmt = number => Number(number ?? 0).toLocaleString('zh-CN');
const deltaText = number => `${number > 0 ? '+' : number < 0 ? '−' : ''}${fmt(Math.abs(number || 0))}`;

export default function RoundResults({ game }) {
  const state = game.state, result = state.roundResult || { players: [], potValue: 0 }, finished = state.phase === 'finished';
  const rows = new Map();
  for (const player of [...(state.departedPlayers || []), ...state.players]) rows.set(player.id, { ...player, balance: player.coins || 0, delta: 0, before: player.coins || 0, cost: 0, winnings: 0 });
  for (const player of result.players || []) rows.set(player.id, { ...rows.get(player.id), ...player });
  const ranking = [...rows.values()].sort((a, b) => b.balance - a.balance);
  const winner = result.reason === 'highest-contribution' ? rows.get(result.winnerId) : null, myResult = rows.get(state.me.id);
  const winnerIds = state.matchWinnerIds || (state.matchWinnerId ? [state.matchWinnerId] : []);
  const champions = winnerIds.map(id => rows.get(id)?.name).filter(Boolean);
  const finalReason = state.finishReason === 'last-standing' ? '只剩一位未失败、未离场的女巫，集会提前分出胜负。' : state.finishReason === 'no-contenders' ? '已经没有继续参与的女巫，本场集会结束。' : '约定的出牌轮数已完成，按最终金币余额排名。';
  return <main className="coin-results"><div className="coin-results-top"><span>第 <b>{state.round}</b> / {state.totalRounds} 轮出牌</span><small>{finished ? '本场集会结束' : '本轮已结算'}</small><span className="coin-results-room">{state.id}</span></div>
    <section className="round-outcome"><div className="outcome-emblem"><Trophy size={30} strokeWidth={1.2}/><span>✧</span></div><span className="tiny-label">{finished ? 'UNTIL OUR NEXT AFTERNOON' : 'A LITTLE RISK, A LITTLE REWARD'}</span><h1>{finished ? champions.length ? `${champions.join('、')}，${champions.length > 1 ? '共享这场胜利。' : '赢得了这场集会。'}` : '这场集会，告一段落。' : '这一锅，收获揭晓。'}</h1><p>{winner ? <><strong>{winner.name}</strong> 的原始投入价值最高，赢得反应后的整锅奖励。</> : result.reason === 'last-standing' ? '本轮尚未开始投料，没有扣除材料金币。' : '本轮已结束，没有女巫获得整锅奖励。'}</p>{finished && <p className="final-reason">{finalReason}</p>}<div className="round-outcome-numbers"><div><span>整锅奖励</span><strong data-wide={fmt(result.potValue).length > 8}><CoinIcon size={25}/>{fmt(result.potValue)}</strong><small>金币</small></div>{myResult && <div className={myResult.eliminated || myResult.status === 'eliminated' ? 'outcome-eliminated' : ''}><span>你的本轮变化</span><strong data-wide={deltaText(myResult.delta).length > 8} className={myResult.delta > 0 ? 'positive' : myResult.delta < 0 ? 'negative' : ''}>{deltaText(myResult.delta)}</strong><small>{myResult.eliminated || myResult.status === 'eliminated' ? '金币归零 · 之后旁观' : '已计入当前金币'}</small></div>}</div>
    </section>
    <section className="coin-ranking" aria-label="金币排行榜"><div className="coin-ranking-heading"><div><Trophy size={17}/><h2>{finished ? '最终排行榜' : '金币排行榜'}</h2></div><span>余额跨轮保留</span></div><div className="coin-ranking-labels"><span>女巫</span><span>当前金币</span><span>本轮增减</span></div>
      {ranking.map((player, index) => {
        const rank = ranking.findIndex(other => other.balance === player.balance) + 1, self = player.id === state.me.id, eliminated = player.eliminated || player.status === 'eliminated', champion = finished && winnerIds.includes(player.id);
        return <article className={`coin-rank-row ${self ? 'is-self' : ''} ${eliminated ? 'is-eliminated' : ''} ${champion ? 'is-champion' : ''}`} key={player.id}><div className="coin-rank-person"><span className={`coin-rank-number ${rank === 1 ? 'first' : ''}`}>{champion ? <Trophy size={17}/> : String(rank).padStart(2, '0')}</span><span className="coin-rank-avatar" aria-hidden="true">{eliminated ? <Eye size={17}/> : '✧'}</span><div><strong>{player.name}{self && <em>你</em>}{player.bot && <em>AI</em>}</strong><p>{eliminated ? <span className="rank-failed">金币归零 · 已失败</span> : player.status === 'departed' ? <span>已离场</span> : <><span>投入 {fmt(player.cost)}</span><i>·</i><span>奖励 {fmt(player.winnings)}</span></>}{presenceLabel(player) === '掉线' && <small>掉线</small>}</p></div></div><div className="coin-rank-balance" data-wide={fmt(player.balance).length > 8}><CoinIcon size={17}/><strong>{fmt(player.balance)}</strong></div><div className={`coin-rank-delta ${player.delta > 0 ? 'positive' : player.delta < 0 ? 'negative' : ''}`}><b data-wide={deltaText(player.delta).length > 8}>{deltaText(player.delta)}</b>{result.reason === 'highest-contribution' && player.id === result.winnerId && <small><Check size={10}/>整锅得主</small>}</div></article>;
      })}
      <p className="ranking-note">本轮增减 = 当前金币 − 轮前金币。投入已扣除，奖励已到账。结算后金币不大于 0 则归零失败。</p>
    </section>
    <div className="coin-results-actions">{finished ? <button className="button primary" onClick={game.leave}><LogOut size={16}/>回到大厅</button> : state.hostId === state.me.id ? <button className="button primary" disabled={!!game.pending || game.connection !== 'connected'} onClick={() => game.action('nextRound')}>开始第 {state.round + 1} 轮出牌<ArrowRight size={16}/></button> : <span><LoaderCircle size={16} className="spin"/>等待房主开始下一轮</span>}{!finished && <button className="text-button" onClick={game.leave}><LogOut size={13}/>离开集会</button>}</div>
  </main>;
}
