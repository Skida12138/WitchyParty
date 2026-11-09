import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--write-env') || args.length > 1) {
  console.error('Usage: npm run invite:generate -- [--write-env]');
  process.exitCode = 1;
} else {
  const inviteCode = randomUUID();
  const hash = createHash('sha256').update(inviteCode, 'utf8').digest('hex');
  if (args.includes('--write-env')) {
    const envPath = fileURLToPath(new URL('../.env', import.meta.url));
    let contents = '';
    try { contents = await readFile(envPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const newline = contents.includes('\r\n') ? '\r\n' : '\n';
    contents = contents.replace(/^[\t ]*(?:export[\t ]+)?INVITE_CODE_SHA256[\t ]*=.*(?:\r?\n|$)/gm, '');
    if (contents && !contents.endsWith('\n')) contents += newline;
    await writeFile(envPath, `${contents}INVITE_CODE_SHA256=${hash}${newline}`, { mode: 0o600 });
  }
  console.log(`邀请码（UUID v4）：${inviteCode}`);
  console.log(`INVITE_CODE_SHA256=${hash}`);
  console.log(args.includes('--write-env')
    ? '已将哈希写入本地 .env。其他配置保持不变；重启服务后生效。请保存上面的原始邀请码并发给朋友。'
    : '将哈希配置到服务端环境变量，将原始邀请码发给朋友。此命令没有修改现有配置。');
}
