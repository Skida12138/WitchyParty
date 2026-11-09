// Deterministic test double. Production code must never import this module.
import { createHash } from 'node:crypto';
import { botPublicContext, normalizeName, presets, validateMaterialName } from '../../server/alchemy.js';

export class FixtureAlchemyProvider {
  constructor({ ready = true, mode = 'test' } = {}) {
    this.ready = ready;
    this.mode = mode;
    this.imaginationCount = 0;
  }

  async price(rawName, context = {}) {
    const name = validateMaterialName(rawName);
    const cached = (context.prices || presets).find(item => normalizeName(item.name) === name);
    const digest = createHash('sha256').update(name).digest();
    const reference = presets[digest.readUInt16BE(0) % presets.length];
    const price = cached?.price ?? Math.max(0, Math.round(reference.price * (0.8 + digest[2] / 255 * 0.4))), constraint = context.priceConstraint;
    return { name, price: constraint ? Math.max(constraint.minPrice, Math.min(constraint.maxPrice, price)) : price, source: cached ? 'cache' : this.mode };
  }

  async synthesize(a, b, context = {}) {
    const [first, second] = [a.name, b.name].sort();
    const adjectives = ['闪烁', '打瞌睡', '会唱歌', '倒流', '冒泡', '透明'];
    const digest = createHash('sha256').update(first).update('\0').update(second).digest();
    const suffix = context.priceConstraint ? '·' + createHash('sha256').update(JSON.stringify(context.priceConstraint)).digest('hex').slice(0, 8).replace(/[0-9a-f]/g, letter => '星月风露花叶云雪雨光梦影铃萤竹羽'[parseInt(letter, 16)]) : '';
    return { name: `${adjectives[digest[0] % adjectives.length]}的${first.slice(0, 10)}与${second.slice(0, 10)}结晶${suffix}`, source: this.mode };
  }

  async imagine(context = {}) {
    const game = botPublicContext(context);
    if (game.me.quotes.length) return { action: 'select', quoteId: game.me.quotes[0].id, source: this.mode };
    const adjectives = ['打瞌睡的', '溜出茶杯的', '沾着蜂蜜的', '忘记方向的', '晒过太阳的', '藏着笑声的', '踮脚跳舞的', '刚刚许愿的'];
    const objects = ['蒲公英伞', '小熊梦境', '云朵纽扣', '猫咪呼噜', '草莓影子', '茶匙月牙', '花园回声', '松饼露珠'];
    const count = this.imaginationCount++;
    const digest = createHash('sha256').update(JSON.stringify(game)).update(String(count)).digest();
    return { action: 'quote', name: `${adjectives[digest[0] % adjectives.length]}${objects[digest[1] % objects.length]}${count > 0 ? `·第${count + 1}份` : ''}`, source: this.mode };
  }
}
