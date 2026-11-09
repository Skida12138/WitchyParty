import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'target');
const binary = path.resolve(root, target, 'debug', `witchy-web-server${process.platform === 'win32' ? '.exe' : ''}`);
const child = spawn(process.execPath, ['--test',
  'tests/integration.test.js', 'tests/invite-access.test.js', 'tests/presence.test.js',
  'tests/bots.test.js', 'tests/bot-decisions.test.js', 'tests/bot-lifecycle.test.js',
], { cwd: root, stdio: 'inherit', env: { ...process.env, WITCHY_SERVER_BIN: binary, WITCHY_FIXTURE_BIN: path.resolve(root, target, 'debug', 'examples', `protocol_fixture${process.platform === 'win32' ? '.exe' : ''}`) } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
