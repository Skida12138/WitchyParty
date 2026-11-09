import assert from 'node:assert/strict';
import { test } from 'node:test';
import { synthesisPricePolicy, synthesisRecipeKey } from '../server/synthesis-pricing.js';
import { rules } from '../server/alchemy.js';

const materials = (a, b) => [{ name: '晨露', price: a }, { name: '月光', price: b }];
const maxPrice = rules.maxMaterialPrice;
const constraint = (band, minPrice, maxPrice) => ({ band, minPrice, maxPrice });

test('10 and 100 use unshifted log10 weights and each draw selects its promised price interval', () => {
  const examples = [
    [0.1, constraint('below', 0, 9)],
    [0.5, constraint('between', 10, 100)],
    [0.9, constraint('above', 101, maxPrice)],
  ];
  for (const [draw, expected] of examples) {
    const result = synthesisPricePolicy(materials(10, 100), draw);
    assert.deepEqual(result.logarithms, [1, 2]);
    assert.deepEqual(result.weights, [1 / 3, 2 / 3]);
    assert.equal(result.draw, draw);
    assert.deepEqual(result.priceConstraint, expected);
  }
});

test('swapping materials preserves the draw, weights and price policy without mutating caller data', () => {
  const originals = Object.freeze(materials(100, 10).map(item => Object.freeze({ ...item, ignored: 'private metadata' })));
  const copy = structuredClone(originals);
  for (const draw of [0, 0.2, 0.5, 0.8, 1]) {
    const forward = synthesisPricePolicy(originals, draw);
    const backward = synthesisPricePolicy([...originals].reverse(), draw);
    assert.deepEqual(forward, backward);
    assert.deepEqual(forward.inputs.map(item => item.price), [10, 100]);
    assert.ok(forward.inputs.every(item => !('ignored' in item)));
  }
  assert.deepEqual(originals, copy);
  assert.deepEqual(synthesisPricePolicy(materials(25, 25), 0.6), synthesisPricePolicy(materials(25, 25).reverse(), 0.6));
});

test('draws exactly at each threshold enter the next interval, with no overlap', () => {
  const pair = materials(10, 100);
  const first = 1 / 3, second = 2 / 3;
  assert.equal(synthesisPricePolicy(pair, first - Number.EPSILON).priceConstraint.band, 'below');
  assert.equal(synthesisPricePolicy(pair, first).priceConstraint.band, 'between');
  assert.equal(synthesisPricePolicy(pair, second - Number.EPSILON).priceConstraint.band, 'between');
  assert.equal(synthesisPricePolicy(pair, second).priceConstraint.band, 'above');
});

test('equal positive prices have no middle probability and split at one half', () => {
  const pair = materials(50, 50);
  assert.deepEqual(synthesisPricePolicy(pair, 0.25).weights, [0.5, 0.5]);
  assert.deepEqual(synthesisPricePolicy(pair, 0.5 - Number.EPSILON).priceConstraint, constraint('below', 0, 49));
  assert.deepEqual(synthesisPricePolicy(pair, 0.5).priceConstraint, constraint('above', 51, maxPrice));
  for (let index = 0; index <= 100; index++) {
    assert.notEqual(synthesisPricePolicy(pair, index / 100).priceConstraint.band, 'between');
  }
});

test('random endpoints are mapped inside the open interval without changing ordinary draws', () => {
  const pair = materials(10, 100);
  assert.equal(synthesisPricePolicy(pair, 0).draw, Number.EPSILON);
  assert.equal(synthesisPricePolicy(pair, 1).draw, 1 - Number.EPSILON);
  for (const draw of [0.1, 0.5, 0.999]) assert.equal(synthesisPricePolicy(pair, draw).draw, draw);
  assert.equal(synthesisPricePolicy(pair, 0).priceConstraint.band, 'below');
  assert.equal(synthesisPricePolicy(pair, 1).priceConstraint.band, 'above');
});

test('zero and one prices produce finite weights and valid nonnegative ranges', () => {
  for (const [low, high] of [[0, 0], [0, 1], [1, 1]]) {
    for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
      const result = synthesisPricePolicy(materials(low, high), draw);
      assert.deepEqual(result.logarithms, [0, 0]);
      assert.deepEqual(result.weights, [0.5, 0.5]);
      assert.deepEqual(result.priceConstraint, draw < 0.5
        ? constraint('below', 0, 0)
        : constraint('above', high + 1, maxPrice));
      assert.ok(Number.isFinite(result.draw));
    }
  }
  for (const low of [0, 1]) {
    for (const draw of [0, 0.5, 1]) {
      const result = synthesisPricePolicy(materials(low, 10), draw);
      assert.deepEqual(result.weights, [0, 1]);
      assert.deepEqual(result.priceConstraint, constraint('between', low, 10));
    }
  }
});

test('the maximum material price never yields an overflowing or empty interval', () => {
  assert.equal(maxPrice, 1000000000);
  assert.deepEqual(synthesisPricePolicy(materials(maxPrice, maxPrice), 0.1).priceConstraint, constraint('below', 0, maxPrice - 1));
  assert.deepEqual(synthesisPricePolicy(materials(maxPrice, maxPrice), 0.9).priceConstraint, constraint('above', maxPrice, maxPrice));
  assert.deepEqual(synthesisPricePolicy(materials(0, maxPrice), 1).priceConstraint, constraint('between', 0, maxPrice));
  const samples = [0, 1, 2, 10, 100, maxPrice - 1, maxPrice];
  for (const first of samples) for (const second of samples) for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
    const result = synthesisPricePolicy(materials(first, second), draw);
    const { minPrice, maxPrice: upper } = result.priceConstraint;
    assert.ok(result.logarithms.every(Number.isFinite));
    assert.ok(result.weights.every(Number.isFinite));
    assert.ok(Number.isSafeInteger(minPrice) && Number.isSafeInteger(upper));
    assert.ok(minPrice >= 0 && minPrice <= upper && upper <= maxPrice);
    assert.ok(result.draw > 0 && result.draw < 1);
  }
});

test('malformed materials cannot enter pricing or produce NaN constraints', () => {
  const valid = { name: '晨露', price: 10 };
  const invalidInputs = [
    undefined, null, {}, 'materials', [], [valid], [valid, valid, valid],
    Array(2), [valid, ,], [undefined, valid], [null, valid], [[], valid],
    [{ name: 10, price: 10 }, valid], [{ price: 10 }, valid],
    [{ name: '', price: 10 }, valid], [{ name: '   ', price: 10 }, valid],
    ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, maxPrice + 1, Number.MAX_SAFE_INTEGER + 1, '10', null, undefined, true].map(price => [{ name: '晨露', price }, valid]),
  ];
  for (const input of invalidInputs) assert.throws(() => synthesisPricePolicy(input, 0.5), /原料/);
});

test('invalid draw values are rejected instead of silently coerced or clamped', () => {
  for (const draw of [undefined, null, false, '0.5', {}, [], Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -Number.EPSILON, 1 + Number.EPSILON]) {
    assert.throws(() => synthesisPricePolicy(materials(10, 100), draw), /抽签/);
  }
});

test('recipe cache keys are unordered but distinguish material prices and price constraints', () => {
  const pair = materials(10, 100);
  const below = constraint('below', 0, 9), between = constraint('between', 10, 100), above = constraint('above', 101, maxPrice);
  const key = synthesisRecipeKey(pair, between);
  assert.equal(key, synthesisRecipeKey([...pair].reverse(), between));
  assert.equal(key, synthesisRecipeKey(pair.map(item => ({ ...item, id: 'irrelevant', source: 'irrelevant' })), between));
  assert.notEqual(key, synthesisRecipeKey(pair, below));
  assert.notEqual(key, synthesisRecipeKey(pair, above));
  assert.notEqual(key, synthesisRecipeKey(materials(11, 100), between));
  assert.notEqual(key, synthesisRecipeKey(pair, constraint('between', 11, 100)));
  assert.notEqual(key, synthesisRecipeKey(pair, constraint('between', 10, 101)));
  const duplicateNames = [{ name: '茶露', price: 10 }, { name: '茶露', price: 100 }];
  assert.equal(synthesisRecipeKey(duplicateNames, between), synthesisRecipeKey([...duplicateNames].reverse(), between));
  assert.notEqual(synthesisRecipeKey([{ name: '甲|乙', price: 10 }, { name: '丙', price: 100 }], between), synthesisRecipeKey([{ name: '甲', price: 10 }, { name: '乙|丙', price: 100 }], between));
});
