import { createInterface } from 'node:readline/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { credentials, settings } from './validation.js';
import { hashPassword } from './auth.js';
import { promptPassword } from './prompt.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = createStore(resolve(process.env.DATA_DIR || resolve(root, 'data'), 'studio.sqlite'));
try {
  if (store.db.prepare('SELECT id FROM owner WHERE id=1').get()) {
    console.log('Owner account already configured. Sign in with your existing credentials.');
  } else {
    if (!process.stdin.isTTY) throw new Error('Run npm run preview in an interactive terminal to create your owner account.');
    console.log('Create your Studio CMS owner account. This account belongs to this preview database.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let name, email;
    try {
      name = (await rl.question('Your name: ')).trim();
      email = (await rl.question('Email address: ')).trim();
    } finally { rl.close(); }
    const details = settings({ name, workspace: 'Studio workspace' });
    const password = await promptPassword('Password (12+ characters; input hidden): ');
    const account = credentials({ email, password }, true);
    if (await promptPassword('Confirm password: ') !== password) throw new Error('Passwords did not match. Run the command again.');
    const hash = await hashPassword(account.password);
    store.transaction(() => {
      if (store.db.prepare('SELECT id FROM owner WHERE id=1').get()) throw new Error('An owner was created in another session. Sign in with that account.');
      store.db.prepare('INSERT INTO owner VALUES(1, ?, ?)').run(account.email, hash);
      store.db.prepare('UPDATE workspace SET revision=revision+1, settings=? WHERE id=1').run(JSON.stringify(details));
      store.log('Created the workspace owner account from the terminal.');
    });
    console.log('Owner account created.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); }
