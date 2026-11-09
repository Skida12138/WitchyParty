import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(root, process.env.ROOM_LOG_DIR || 'logs/rooms');
const requested = process.argv[2];
const safeText = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

async function main() {
  if (requested && !/^[A-Za-z0-9-]+$/.test(requested)) throw new Error('请输入房间码，例如 npm run logs -- A1B2C3');
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const entries = await Promise.all(names.filter(name => name.endsWith('.log')).map(async name => ({ name, modified: (await stat(path.join(directory, name))).mtimeMs })));
  entries.sort((a, b) => b.modified - a.modified);
  console.log(`房间日志目录：${directory}\n`);
  if (!entries.length) {
    console.log('还没有房间日志。创建新房间后会自动开始记录。');
    return;
  }
  if (!requested) {
    console.log('可查看的房间日志（最新在前）：');
    for (const entry of entries) console.log(`${new Date(entry.modified).toISOString()}  ${entry.name}`);
    console.log('\n查看指定房间：npm run logs -- 房间码');
    return;
  }
  const match = entries.find(entry => entry.name.toUpperCase().startsWith(`${requested.toUpperCase()}-`) || entry.name.toUpperCase() === `${requested.toUpperCase()}.LOG`);
  if (!match) throw new Error(`没有找到房间 ${requested} 的日志；可运行 npm run logs 查看列表`);
  console.log(`文件：${match.name}\n`);
  console.log(safeText(await readFile(path.join(directory, match.name), 'utf8')));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
