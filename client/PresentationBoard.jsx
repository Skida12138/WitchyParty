import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlaskConical, Sparkles } from 'lucide-react';
import CoinIcon from './CoinIcon.jsx';
import './presentation.css';

const TIERS = { white: ['寻常', '#c3bbc7'], green: ['微光', '#a3c88f'], blue: ['秘藏', '#8cabd9'], purple: ['奇珍', '#b19ad2'], gold: ['传说', '#d0b67a'], red: ['禁忌', '#dc8a8f'] };
const DEPOSIT_ARRIVAL = .76, REACTION_FORM = .65;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
const fmt = value => Number(value ?? 0).toLocaleString('zh-CN');
const center = node => { const rect = node?.getBoundingClientRect(); return rect && rect.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; };

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { const media = window.matchMedia('(prefers-reduced-motion: reduce)'), update = () => setReduced(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  return reduced;
}

// The server's frame identity anchors this clock. Repeated snapshots can only
// move it forward; a presence update never restarts a material's journey.
function usePresentationClock(frame, serverTime) {
  const key = `${frame.id}:${frame.index}:${frame.startedAt}`, duration = Math.max(1, Number(frame.durationMs) || 1);
  const anchor = useRef(null), [, tick] = useState(0), now = performance.now();
  const reported = Math.max(0, (Number(serverTime) || Date.now()) - Number(frame.startedAt));
  if (anchor.current?.key !== key) anchor.current = { key, at: now, elapsed: reported, serverTime };
  else if (anchor.current.serverTime !== serverTime) anchor.current = { key, at: now, elapsed: Math.max(reported, anchor.current.elapsed + now - anchor.current.at), serverTime };
  const elapsed = Math.min(duration, Math.max(0, anchor.current.elapsed + now - anchor.current.at));
  useEffect(() => {
    let request, stopped = false;
    const draw = () => {
      if (stopped) return;
      tick(value => value + 1);
      if (anchor.current.elapsed + performance.now() - anchor.current.at < duration) request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(request); };
  }, [key, duration]);
  return { key, elapsed, duration, progress: clamp(elapsed / duration) };
}

function MaterialFace({ card, owner, index, className = '', style, hidden = false, stage, visible }) {
  const quality = TIERS[card.tier] || TIERS.white;
  return <article className={`presentation-card tier-${card.tier || 'white'} ${className}`} data-material-id={card.id} data-stage={stage} data-visible={visible} aria-hidden={hidden || undefined} aria-label={`${card.name}，${fmt(card.price)} 金币`} title={card.name} style={style}>
    <span className="presentation-card-order">{String(index + 1).padStart(2, '0')}</span><span className="presentation-card-tier">{quality[0]}</span><span className="presentation-card-symbol" aria-hidden="true">✧</span><h2>{card.name}</h2><strong data-wide={fmt(card.price).length > 8}><CoinIcon size={19}/>{fmt(card.price)}</strong><p>{owner || '新生的灵感'}<small>{className.includes('presentation-product') ? '反应产物' : '坩埚中的材料'}</small></p>
  </article>;
}

function ParticleLayer({ frame, progress, slots, avatarRefs, productSlotId }) {
  const particles = useRef([]), layer = useRef(null), rememberedSources = useRef(new Map()), deposit = frame.kind === 'deposit';
  const count = deposit ? 18 : 26;
  useLayoutEffect(() => {
    const target = center(slots.current.get(deposit ? frame.material?.id : productSlotId));
    const origin = deposit ? center(avatarRefs.current.get(frame.playerId)) : null;
    if (layer.current && target) {
      layer.current.dataset.targetX = String(target.x); layer.current.dataset.targetY = String(target.y);
      if (origin) { layer.current.dataset.sourceX = String(origin.x); layer.current.dataset.sourceY = String(origin.y); }
    }
    for (let index = 0; index < count; index++) {
      const node = particles.current[index];
      if (!node) continue;
      const ingredient = !deposit && frame.ingredients?.[Math.floor(index / 13)];
      const measuredSource = !deposit && center(slots.current.get(ingredient?.id));
      if (measuredSource) rememberedSources.current.set(ingredient.id, measuredSource);
      const source = deposit ? origin : measuredSource || rememberedSources.current.get(ingredient?.id);
      const start = deposit ? .035 + index * .004 : .18 + (index % 13) * .008;
      const finish = deposit ? DEPOSIT_ARRIVAL : REACTION_FORM;
      const travel = clamp((progress - start) / (finish - start));
      if (!target || !source || progress <= start || travel >= 1) { node.style.opacity = '0'; continue; }
      const angle = index * 2.399963, spread = deposit ? 12 : 30;
      const from = { x: source.x + Math.cos(angle) * spread, y: source.y + Math.sin(angle) * spread };
      const control = { x: (from.x + target.x) / 2 + Math.cos(angle) * (deposit ? 38 : 70), y: Math.min(from.y, target.y) - (deposit ? 45 : 55) - index % 5 * 8 };
      const t = smooth(travel), inverse = 1 - t;
      const x = inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * target.x;
      const y = inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * target.y;
      node.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%) scale(${.6 + Math.sin(travel * Math.PI) * .8})`;
      node.style.opacity = String(Math.min(1, travel * 10, (1 - travel) * 7));
      node.style.setProperty('--particle-color', (TIERS[(deposit ? frame.material : ingredient)?.tier] || TIERS.green)[1]);
    }
  }, [frame, progress, slots, avatarRefs, productSlotId, count, deposit]);
  return createPortal(<div ref={layer} className={`presentation-particles ${deposit ? 'deposit-particles' : 'reaction-particles'}`} data-frame-id={frame.id} data-frame-index={frame.index} aria-hidden="true">{Array.from({ length: count }, (_, index) => <i key={index} ref={node => { particles.current[index] = node; }} className={`presentation-flight-particle ${index === 0 ? 'is-leading' : ''}`} style={{ '--particle-size': `${index === 0 ? 8 : 3 + index % 3}px` }}/>)}</div>, document.body);
}

export default function PresentationBoard({ state, avatarRefs, onProgressState }) {
  const frame = state.presentation;
  if (!frame) return null;
  return <PresentationFrame key={`${state.id}:${state.round}`} state={state} frame={frame} avatarRefs={avatarRefs} onProgressState={onProgressState}/>;
}

function PresentationFrame({ state, frame, avatarRefs, onProgressState }) {
  const { key, elapsed, duration, progress: frameProgress } = usePresentationClock(frame, state.serverTime), reduced = useReducedMotion();
  const animationValue = Number(frame.animationMs), holdValue = Number(frame.holdMs);
  const animationMs = frame.animationMs != null && Number.isFinite(animationValue) ? Math.max(0, Math.min(duration, animationValue)) : duration;
  const holdMs = frame.holdMs != null && Number.isFinite(holdValue) ? Math.max(0, holdValue) : Math.max(0, duration - animationMs);
  const progress = animationMs <= 0 ? 1 : clamp(elapsed / animationMs), holding = animationMs <= 0 || elapsed >= animationMs;
  const slotRefs = useRef(new Map()), previousPositions = useRef(new Map()), galleryRef = useRef(null);
  const deposit = frame.kind === 'deposit', before = frame.potBefore || state.pot || [], after = frame.potAfter || before;
  const ingredients = new Set((frame.ingredients || []).map(card => card.id));
  const firstIngredient = before.find(card => ingredients.has(card.id));
  const finalLayout = deposit || reduced || progress >= REACTION_FORM;
  const cards = finalLayout ? after : before;
  const productSlotId = finalLayout ? frame.product?.id : firstIngredient?.id;
  const dissolve = reduced ? 1 : smooth((progress - .18) / (REACTION_FORM - .18));
  const birthStart = deposit ? DEPOSIT_ARRIVAL : REACTION_FORM, birth = reduced ? 1 : smooth((progress - birthStart) / (1 - birthStart));
  const cardSettled = reduced || holding || birth >= 1;
  const formed = reduced || progress >= REACTION_FORM;
  const layoutKey = `${key}:${cards.map(card => card.id).join(',')}`;
  const ownerName = card => [...state.players, ...(state.departedPlayers || [])].find(player => player.id === card.ownerId)?.name;
  const attach = id => node => { if (node) slotRefs.current.set(id, node); else slotRefs.current.delete(id); };

  useLayoutEffect(() => {
    const next = new Map(), animations = [];
    const positions = [...slotRefs.current].map(([id, node]) => {
      const rect = node.getBoundingClientRect(); next.set(id, rect);
      return { node, rect, old: previousPositions.current.get(id) || (id === frame.product?.id && previousPositions.current.get(firstIngredient?.id)) };
    });
    // When wrapping changes rows, materialize cards in their new slots instead
    // of sending them diagonally through cards that remain on the table.
    const wrapsRows = !deposit && positions.some(({ old, rect }) => old && Math.abs(old.top - rect.top) > 2);
    for (const { node, old, rect } of positions) {
      if (!reduced && !holding && old && (Math.abs(old.left - rect.left) > 1 || Math.abs(old.top - rect.top) > 1)) {
        const frames = wrapsRows ? [{ opacity: .25 }, { opacity: 1 }] : [{ transform: `translate(${old.left - rect.left}px,${old.top - rect.top}px)` }, { transform: 'translate(0,0)' }];
        animations.push(node.animate(frames, { duration: Math.max(1, deposit ? Math.min(350, animationMs * .2, animationMs - elapsed) : animationMs - elapsed), easing: 'cubic-bezier(.2,.7,.3,1)' }));
      }
    }
    previousPositions.current = next;
    return () => animations.forEach(animation => animation.cancel());
  }, [layoutKey, reduced, holding]);

  useLayoutEffect(() => { onProgressState?.({ key, completed: holding || reduced }); }, [key, holding, reduced, onProgressState]);

  useEffect(() => {
    const rememberPositions = () => {
      previousPositions.current = new Map([...slotRefs.current].map(([id, node]) => [id, node.getBoundingClientRect()]));
    };
    const observer = new ResizeObserver(rememberPositions);
    if (galleryRef.current) observer.observe(galleryRef.current);
    window.addEventListener('resize', rememberPositions);
    window.addEventListener('scroll', rememberPositions, { capture: true, passive: true });
    return () => { observer.disconnect(); window.removeEventListener('resize', rememberPositions); window.removeEventListener('scroll', rememberPositions, true); };
  }, []);

  useEffect(() => {
    const avatar = avatarRefs.current.get(frame.playerId), row = avatar?.closest('.gathering-players');
    if (!avatar || !row) return;
    const source = avatar.getBoundingClientRect(), bounds = row.getBoundingClientRect();
    if (source.left < bounds.left + 10 || source.right > bounds.right - 10) row.scrollBy({ left: source.left + source.width / 2 - bounds.left - bounds.width / 2, behavior: reduced ? 'instant' : 'smooth' });
  }, [key, reduced, avatarRefs, frame.playerId]);

  return <div className={`presentation-board ${deposit ? 'is-deposit' : 'is-reaction'} ${reduced ? 'is-reduced-motion' : ''} ${holding ? 'is-holding' : ''}`} data-presentation-id={frame.id} data-presentation-index={frame.index} data-presentation-kind={frame.kind} data-elapsed-ms={Math.round(elapsed)} data-duration-ms={duration} data-animation-ms={animationMs} data-hold-ms={holdMs} data-progress={frameProgress.toFixed(3)} data-motion-progress={progress.toFixed(3)} data-holding={String(holding)} data-reduced-motion={String(reduced)}>
    <div className="presentation-caption" role="status"><span className="presentation-kind">{deposit ? <FlaskConical size={15}/> : <Sparkles size={15}/>}<span>{deposit ? `${frame.playerName} ${holding || reduced ? '已投入' : '正在投料'}` : holding || reduced ? '反应完成' : '材料正在发生反应'}</span></span><small>第 {frame.index + 1} / {frame.total} 幕</small></div>
    {!deposit && <p className="presentation-recipe">{(frame.ingredients || []).map(card => card.name).join(' ＋ ')}<span aria-hidden="true">✦</span>{formed ? frame.product?.name : '新的灵感正在诞生'}</p>}
    <div ref={galleryRef} className="presentation-gallery" aria-label="坩埚中的材料，按投入顺序排列">
      {cards.map((card, index) => {
        const incoming = deposit && card.id === frame.material?.id, consumed = !deposit && !finalLayout && ingredients.has(card.id), targetSlot = !deposit && !finalLayout && card.id === firstIngredient?.id;
        const product = !deposit && finalLayout && card.id === frame.product?.id;
        const visible = !incoming || reduced || progress >= DEPOSIT_ARRIVAL;
        return <div className={`presentation-slot ${incoming && !visible ? 'presentation-reserved-slot' : ''} ${consumed ? 'is-reacting-slot' : ''}`} key={card.id} ref={attach(card.id)} data-slot-id={card.id}>
          {incoming && !visible && <div className="presentation-slot-wait" aria-hidden="true"><span>✧</span><small>灵感正在抵达</small></div>}
          <MaterialFace card={card} owner={ownerName(card)} index={index} className={`${incoming ? 'presentation-deposit-card' : ''} ${consumed ? 'presentation-reactant' : ''} ${product ? 'presentation-product' : ''}`} stage={consumed ? progress < .18 ? 'waiting' : formed ? 'formed' : 'dissolving' : undefined} visible={String(visible)} hidden={!visible || consumed && formed} style={incoming || product ? cardSettled ? { opacity: 1, transform: 'none', filter: 'none' } : { opacity: birth, transform: `scale(${.87 + birth * .13})`, filter: `blur(${(1 - birth) * 5}px)` } : consumed ? { opacity: 1 - dissolve, transform: reduced ? 'none' : `scale(${1 - dissolve * .13})`, filter: `blur(${dissolve * 7}px)` } : undefined}/>
          {targetSlot && <><span className="presentation-product-flare" aria-hidden="true" style={{ opacity: Math.sin(clamp((progress - .34) / .5) * Math.PI) * .85, transform: `translate(-50%,-50%) scale(${.4 + progress})` }}/><MaterialFace card={frame.product} owner={ownerName(frame.product)} index={index} className="presentation-product presentation-product-overlay" visible={String(formed)} hidden={!formed} style={{ opacity: birth, transform: reduced ? 'none' : `scale(${.86 + birth * .14})`, filter: `blur(${(1 - birth) * 5}px)` }}/></>}
        </div>;
      })}
    </div>
    <div className="presentation-progress" role="progressbar" aria-label={deposit ? '材料入锅进度' : '材料反应进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${progress * 100}%` }}/></div>
    <p className="presentation-footnote">{deposit ? `「${frame.material?.name || '材料'}」${progress >= DEPOSIT_ARRIVAL || reduced ? '已经入锅。' : '从女巫的手中，飞向这一锅灵感。'}` : formed ? `「${frame.product?.name || '新的材料'}」诞生了。` : '两份材料化作微光，正在凝成新的模样。'}</p>
    {!reduced && !holding && progress < (deposit ? .8 : .7) && <ParticleLayer frame={frame} progress={progress} slots={slotRefs} avatarRefs={avatarRefs} productSlotId={productSlotId}/>}
  </div>;
}
