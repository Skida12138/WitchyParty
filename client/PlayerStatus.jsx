import React from 'react';
import { WifiOff } from 'lucide-react';
import './connection.css';

export const presenceLabel = player => player?.status === 'departed' ? '已离场' : player?.connected === false ? '掉线' : '';
export const presenceDescription = player => player?.status === 'departed' ? '已离场' : player?.connected === false ? player.departurePending ? '掉线 · 本轮结束后离开' : '掉线 · 等待重连' : '';

export default function PlayerConnectionMark({ player }) {
  const label = presenceLabel(player);
  if (!label) return null;
  return <span className={`avatar-connection-mark ${label === '已离场' ? 'is-departed' : ''}`} role="img" aria-label={label} title={presenceDescription(player)}><WifiOff size={10}/></span>;
}

export function DisconnectedPlayers({ players }) {
  const offline = players.filter(player => player.connected === false && player.status !== 'departed');
  if (!offline.length) return null;
  return <div className="disconnected-players" role="status" aria-label="掉线的女巫">{offline.map(player => <span key={player.id}><WifiOff size={12}/><strong>{player.name}</strong><small>{presenceDescription(player)}</small></span>)}</div>;
}
