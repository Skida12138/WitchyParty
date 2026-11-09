import { mkdir, writeFile } from 'node:fs/promises';
import { AlchemyProvider, presets } from '../server/alchemy.js';

// Explicit live evaluation. Never used by npm test; requires a real server-side key.
const provider = new AlchemyProvider();
if (!provider.ready) throw new Error('请配置 DEEPSEEK_API_KEY 后运行真实命名效果验证');
const cases = [
  { label: '截图中的材料', a: '沾着蜂蜜的草莓影子·第13份', b: '梁文锋' },
  { label: '茶点与火焰', a: '会打嗝的薄荷', b: '凤凰余烬' },
  { label: '抽象意象', a: '一句没有说出口的晚安', b: '晒过太阳的影子' },
  { label: '日常材料', a: '生锈的铁钉', b: '一片橘子皮' },
  { label: '跨物态联想', a: '一朵忘记下雨的云', b: '停在三点的怀表' },
  { label: '含旧结晶记录的连锁合成', a: '透明的梁文锋与沾着蜂蜜的草莓影子·结晶', b: '会唱歌的茶匙', history: [
    { ingredients: ['沾着蜂蜜的草莓影子·第13份', '梁文锋'], name: '透明的梁文锋与沾着蜂蜜的草莓影子·结晶' },
  ] },
];
const results = [];
for (const sample of cases) {
  // Repeat each pair twice to inspect variation without sending a large paid batch.
  const names = await Promise.all([1, 2].map(async repetition => {
    const start = Date.now();
    const result = await provider.synthesize({ name: sample.a, price: 200 }, { name: sample.b, price: 800 }, { prices: presets, history: sample.history || [] });
    return {
      case: sample.label, repetition, ingredients: [sample.a, sample.b], name: result.name,
      source: result.source, milliseconds: Date.now() - start,
      containsCrystal: result.name.includes('结晶'),
      copiesBothIngredients: [sample.a, sample.b].every(name => result.name.includes(name.slice(0, 6))),
    };
  }));
  results.push(...names);
  for (const result of names) console.log(JSON.stringify(result));
}
const report = {
  evaluatedAt: new Date().toISOString(), model: provider.model, calls: results.length,
  crystalNames: results.filter(result => result.containsCrystal).length,
  mechanicalNames: results.filter(result => result.copiesBothIngredients).length,
  uniqueNames: new Set(results.map(result => result.name)).size,
  note: '小样本真实 API 验证；不保证模型未来每次输出，创意质量需结合原料人工查看。', results,
};
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/deepseek-synthesis-evaluation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ calls: report.calls, crystalNames: report.crystalNames, mechanicalNames: report.mechanicalNames, uniqueNames: report.uniqueNames }));
