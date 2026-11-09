import React from 'react';

export default function CoinIcon({ size = 20, className = '' }) {
  return <svg className={`coin-icon ${className}`} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"><ellipse cx="17" cy="17" rx="12" ry="13" fill="#8e6e36"/><circle cx="15" cy="15" r="12" fill="#d5b870" stroke="#f0d99b" strokeWidth="1.5"/><circle cx="15" cy="15" r="8.5" stroke="#9e7d3e" strokeWidth="1.2"/><path d="m15 9 1.8 4.2L21 15l-4.2 1.8L15 21l-1.8-4.2L9 15l4.2-1.8L15 9Z" fill="#fff0ba"/></svg>;
}
