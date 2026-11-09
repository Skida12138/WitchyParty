// Local QA server only. Never imports into the production browser or server.
import { spawn } from 'node:child_process';
import { createDeepSeekStub } from '../tests/helpers/deepseek-stub.js';
import { testInviteHash } from './helpers/invite-fixture.mjs';
const api = await createDeepSeekStub();
const port = process.env.PORT || '3101';
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('..', import.meta.url), windowsHide: true, stdio: 'inherit',
  env: { ...process.env, PORT: port, HOST: '127.0.0.1', DEEPSEEK_API_KEY: 'local-qa-dummy-key', DEEPSEEK_BASE_URL: api.url, ROOM_LOG_ENABLED: '0', INVITE_CODE_SHA256: testInviteHash },
});
console.log(`Local QA HTTP fixture configured for http://127.0.0.1:${port}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; child.kill(); await api.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', async code => { await stop(); process.exitCode = code || 0; });
