import { normalizeName, rules } from './alchemy.js';

// Keep log10(price) for ordinary prices. Zero has no finite logarithm, and
// prices 0/1 carry zero weight; two zero weights share the probability equally.
export function synthesisPricePolicy(materials, rawDraw) {
  if (!Array.isArray(materials) || materials.length !== 2 || [...materials].some(item => !item || typeof item.name !== 'string' || !item.name.trim() || !Number.isSafeInteger(item.price) || item.price < 0 || item.price > rules.maxMaterialPrice)) throw new Error('合成原料信息无效');
  if (!Number.isFinite(rawDraw) || rawDraw < 0 || rawDraw > 1) throw new Error('合成价格抽签无效');
  const inputs = materials.map(({ name, price }) => ({ name: normalizeName(name), price })).sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  const logarithms = inputs.map(item => Math.log10(Math.max(1, item.price)));
  const total = logarithms[0] + logarithms[1];
  const weights = total > 0 ? logarithms.map(value => value / total) : [0.5, 0.5];
  const draw = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, rawDraw));
  const [low, high] = inputs.map(item => item.price);
  const band = draw < weights[0] ? 'below' : draw < weights[1] ? 'between' : 'above';
  const ranges = {
    below: [0, Math.max(0, low - 1)],
    between: [low, high],
    above: [Math.min(rules.maxMaterialPrice, high + 1), rules.maxMaterialPrice],
  };
  const [minPrice, maxPrice] = ranges[band];
  return { inputs, logarithms, weights, draw, priceConstraint: { band, minPrice, maxPrice } };
}

export function synthesisRecipeKey(inputs, constraint) {
  const pair = inputs.map(({ name, price }) => ({ name, price })).sort((a, b) => a.name.localeCompare(b.name) || a.price - b.price);
  return JSON.stringify([pair, constraint.band, constraint.minPrice, constraint.maxPrice]);
}
