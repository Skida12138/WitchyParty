import React, { useId } from 'react';
import './mana.css';

export default function ManaIcon({ size = 20, className = '' }) {
  const id = useId().replaceAll(':', '');
  return <svg className={`mana-icon ${className}`} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <defs><linearGradient id={`${id}-mana`} x1="8" y1="4" x2="25" y2="28" gradientUnits="userSpaceOnUse"><stop stopColor="#e0e9cf"/><stop offset=".45" stopColor="#b6cda9"/><stop offset="1" stopColor="#9d85c2"/></linearGradient></defs>
    <path d="M16 2.5 26.5 15.7 16 29.5 5.5 15.7 16 2.5Z" fill={`url(#${id}-mana)`} stroke="#dce7d2" strokeWidth="1" strokeLinejoin="round"/>
    <path d="m16 2.5 2.5 13.2L16 29.5l-5-13.8L16 2.5Z" fill="#f0f4df" fillOpacity=".68"/>
    <path d="m5.5 15.7 10.5 3.7 10.5-3.7M16 2.5v27" stroke="#f0f6e3" strokeOpacity=".56" strokeWidth=".8"/>
    <path d="m25 4 .8 2.1 2.2.9-2.2.8L25 10l-.8-2.2L22 7l2.2-.9L25 4Z" fill="#e7e6be"/>
  </svg>;
}
