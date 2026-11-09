import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import CoinIcon from './CoinIcon.jsx';
import './winner-celebration.css';

const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => 1 - (1 - clamp(value)) ** 3;
const fmt = value => Number(value ?? 0).toLocaleString('zh-CN');
const rectOf = node => {
  const rect = node?.getBoundingClientRect();
  return rect?.width && rect?.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, size: rect.width } : null;
};

export default function WinnerCelebration({ celebration, serverTime, avatarRefs, renderAvatar, onContinue }) {
  const overlayRef = useRef(null), targetRef = useRef(null), buttonRef = useRef(null);
  const [geometry, setGeometry] = useState(null), [, tick] = useState(0);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const clock = useRef(null), duration = Math.max(1, Number(celebration.animationMs) || 1200);
  const now = performance.now(), reported = Math.max(0, (Number(serverTime) || Date.now()) - Number(celebration.startedAt));
  if (clock.current?.id !== celebration.id) clock.current = { id: celebration.id, elapsed: reported, at: now, serverTime };
  else if (clock.current.serverTime !== serverTime) clock.current = { ...clock.current, elapsed: Math.max(reported, clock.current.elapsed + now - clock.current.at), at: now, serverTime };
  const elapsed = Math.min(duration, Math.max(0, clock.current.elapsed + now - clock.current.at));
  const progress = clamp(elapsed / duration), travel = ease(progress);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)'), update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let frame, stopped = false;
    const draw = () => {
      if (stopped) return;
      tick(value => value + 1);
      if (clock.current.elapsed + performance.now() - clock.current.at < duration) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [celebration.id, duration]);

  useLayoutEffect(() => {
    const sourceNode = avatarRefs.current.get(celebration.winner.id)?.querySelector('.avatar') || avatarRefs.current.get(celebration.winner.id);
    const source = rectOf(sourceNode);
    const oldOverflow = document.body.style.overflow, oldPadding = document.body.style.paddingRight;
    const scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    const currentPadding = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
    document.body.style.overflow = 'hidden';
    if (scrollbar) document.body.style.paddingRight = `${currentPadding + scrollbar}px`;
    const oldVisibility = sourceNode?.style.visibility;
    if (sourceNode) sourceNode.style.visibility = 'hidden';
    const measure = () => {
      const target = rectOf(targetRef.current);
      if (target) setGeometry({ source: source || { ...target, size: target.size * .7 }, target, hasSource: Boolean(source) });
    };
    measure();
    buttonRef.current?.focus({ preventScroll: true });
    const overlay = overlayRef.current, observer = new ResizeObserver(measure);
    observer.observe(targetRef.current);
    window.addEventListener('resize', measure);
    overlay?.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      overlay?.removeEventListener('scroll', measure);
      document.body.style.overflow = oldOverflow;
      document.body.style.paddingRight = oldPadding;
      if (sourceNode) sourceNode.style.visibility = oldVisibility;
    };
  }, [celebration.id, celebration.winner.id, avatarRefs]);

  const origin = geometry?.source, target = geometry?.target;
  const flying = geometry && !reduced && geometry.hasSource;
  const x = target ? flying ? origin.x + (target.x - origin.x) * travel : target.x : 0;
  const y = target ? flying ? origin.y + (target.y - origin.y) * travel : target.y : 0;
  const scale = target ? flying ? origin.size / target.size + (1 - origin.size / target.size) * travel : 1 : 1;
  const opacity = reduced || !geometry?.hasSource ? clamp(elapsed / Math.min(300, duration)) : 1;
  const detailsOpacity = reduced ? opacity : ease((progress - .2) / .8);
  const keyDown = event => {
    if (event.key === 'Tab') { event.preventDefault(); buttonRef.current?.focus({ preventScroll: true }); }
    if (event.key === 'Escape' || (event.target === event.currentTarget && ['Enter', ' '].includes(event.key))) {
      event.preventDefault(); onContinue();
    }
  };

  return createPortal(<section ref={overlayRef} className="winner-celebration" role="dialog" aria-modal="true" aria-labelledby="winner-name" aria-describedby="winner-offering" tabIndex={-1} onClick={onContinue} onKeyDown={keyDown}
    data-celebration-id={celebration.id} data-winner-id={celebration.winner.id} data-elapsed-ms={Math.round(elapsed)} data-progress={progress.toFixed(3)} data-reduced-motion={String(reduced)}>
    <div className="winner-frost" aria-hidden="true"/>
    <div className="winner-stage">
      <div ref={targetRef} className="winner-avatar-target" aria-hidden="true"/>
      <div className="winner-details" style={{ opacity: detailsOpacity }}>
        <p className="winner-label">本轮赢家</p>
        <h1 id="winner-name" className="winner-name">{celebration.winner.name}</h1>
        <div id="winner-offering" className="winner-offering"><p>本轮原始投入</p><h2 className="winner-material-name">{celebration.material.name}</h2><strong className="winner-material-price" data-price={celebration.material.price}><CoinIcon size={24}/><span>{fmt(celebration.material.price)}</span><small>金币</small></strong></div>
        <button ref={buttonRef} className="winner-continue" type="button">点击查看排行榜<ArrowRight size={16}/></button>
      </div>
    </div>
    <div className="winner-flight-avatar" aria-hidden="true" data-source-x={origin?.x} data-source-y={origin?.y} data-source-size={origin?.size} data-target-x={target?.x} data-target-y={target?.y} data-target-size={target?.size}
      style={{ width: target?.size, height: target?.size, opacity: geometry ? opacity : 0, transform: `translate3d(${x}px,${y}px,0) translate(-50%,-50%) scale(${scale})` }}>
      <span className="winner-gold-aura" style={{ opacity: ease((progress - .1) / .9) }}/>
      {renderAvatar(celebration.winner)}
    </div>
  </section>, document.body);
}
