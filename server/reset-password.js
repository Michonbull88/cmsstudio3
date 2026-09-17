import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { hashPassword } from './auth.js';
import { credentials } from './validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.stdin.isTTY) throw new Error('Run password recovery in an interactive terminal.');
function promptPassword(label) {
  return new Promise(resolve => {
    process.stdout.write(label);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
        if (char === '\r' || char === '\n') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(value); return;
        }
        if (char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 256) value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
const store = createStore(resolve(process.env.DATA_DIR || resolve(root, 'data'), 'studio.sqlite'));
try {
  const owner = store.db.prepare('SELECT email FROM owner WHERE id=1').get();
  if (!owner) throw new Error('Open the app to create an owner account first.');
  const password = await promptPassword('New owner password (12+ characters; input hidden): ');
  credentials({ email: owner.email, password }, true);
  const confirm = await promptPassword('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords did not match. Nothing changed.');
  const hash = await hashPassword(password);
  store.transaction(() => {
    store.db.prepare('UPDATE owner SET password=? WHERE id=1').run(hash);
    store.db.exec('DELETE FROM sessions');
    store.log('Reset the owner password through local account recovery.');
  });
  console.log('Password updated. All sessions have been signed out.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); }
