import { promptPassword } from './prompt.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { hashPassword } from './auth.js';
import { credentials } from './validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.stdin.isTTY) throw new Error('Run password recovery in an interactive terminal.');
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
