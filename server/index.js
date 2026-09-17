import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createStore } from './store.js';
import { credentials, requireValue, HttpError } from './validation.js';
import { hashPassword, verifyPassword, createSession, getSession, sessionCookie } from './auth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const publicHtml = (workspace, entry) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(entry?.title || workspace.settings.workspace)}</title><meta name="description" content="${escape(entry?.excerpt || 'The latest stories from our studio.')}"><link rel="stylesheet" href="/style.css"><style>body{padding:50px 24px}.publication{max-width:780px;margin:auto}.publication header{border-bottom:1px solid #dfe5d9;padding-bottom:24px;margin-bottom:40px}.publication h1{font:700 36px Manrope,sans-serif;letter-spacing:-1px}.publication h2{font-size:23px}.publication article{padding:24px 0;border-bottom:1px solid #dfe5d9}.publication p{line-height:1.9;white-space:pre-wrap;color:#65715e}.publication time{font-size:12px;color:#89908b}</style></head><body><main class="publication"><header><a href="/site">${escape(workspace.settings.workspace)}</a></header>${entry ? `<article><time>${escape(entry.category)} · ${escape(new Date(entry.date).toLocaleDateString('en-GB'))}</time><h1>${escape(entry.title)}</h1><p>${escape(entry.excerpt)}</p><p>${escape(entry.body)}</p></article><p><a href="/site">← All stories</a></p>` : `<h1>Stories from the studio.</h1>${workspace.entries.filter(e => e.status === 'Published').sort((a,b) => b.date.localeCompare(a.date)).map(e => `<article><time>${escape(e.category)} · ${escape(new Date(e.date).toLocaleDateString('en-GB'))}</time><h2><a href="/site/${encodeURIComponent(e.id)}">${escape(e.title)}</a></h2><p>${escape(e.excerpt)}</p><a class="text-link" href="/site/${encodeURIComponent(e.id)}">Read story →</a></article>`).join('') || '<p>Our first story is on its way.</p>'}`}</main></body></html>`;

export function createApplication({ dbPath = resolve(root, 'data/studio.sqlite'), origin = 'http://localhost:3000', schedulerMs = 10000, secureCookies = false } = {}) {
  const store = createStore(dbPath);
  const allowedOrigin = new URL(origin).origin;
  const attempts = new Map();
  function throttle(req) {
    const now = Date.now(), key = req.socket.remoteAddress;
    for (const [ip, value] of attempts) if (value.until < now) attempts.delete(ip);
    const item = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
    item.count++;
    attempts.set(key, item);
    requireValue(item.count <= 15, 'Too many sign-in attempts. Please try again in 15 minutes.', 429);
  }
  async function body(req) {
    requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Send application/json.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 20000000) throw new HttpError(413, 'Workspace request exceeds 20 MB.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  function send(res, status, value, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      requireValue(req.headers.host === new URL(allowedOrigin).host, 'Use the configured workspace address.', 403);
      const url = new URL(req.url, allowedOrigin), path = url.pathname, method = req.method;
      if (!['GET', 'HEAD'].includes(method)) {
        requireValue(req.headers['x-studio-request'] === '1', 'Missing request verification header.', 403);
        requireValue(!req.headers.origin || req.headers.origin === allowedOrigin, 'Cross-origin requests are not allowed.', 403);
        requireValue(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'Cross-site requests are not allowed.', 403);
      }
      if (path === '/api/health' && method === 'GET') return send(res, 200, { ok: true });
      if (path === '/api/auth/status' && method === 'GET') {
        const owner = store.db.prepare('SELECT email FROM owner WHERE id=1').get(), session = getSession(store, req);
        return send(res, 200, { setupRequired: !owner, authenticated: !!session, ...(session ? { email: owner.email, csrf: session.csrf } : {}) });
      }
      if (['/api/auth/setup', '/api/auth/login'].includes(path) && method === 'POST') {
        throttle(req);
        const setup = path.endsWith('setup');
        const input = await body(req), { email, password } = credentials(input, setup);
        let owner = store.db.prepare('SELECT * FROM owner WHERE id=1').get();
        if (setup) {
          requireValue(!owner, 'This workspace already has an owner.', 409);
          requireValue(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'], 'Create the owner account locally before exposing the server.', 403);
          requireValue(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 80, 'Enter your display name.');
          const hash = await hashPassword(password);
          store.transaction(() => {
            requireValue(!store.db.prepare('SELECT id FROM owner').get(), 'This workspace already has an owner.', 409);
            store.db.prepare('INSERT INTO owner VALUES(1, ?, ?)').run(email, hash);
            store.db.prepare('UPDATE workspace SET settings=?, revision=revision+1 WHERE id=1').run(JSON.stringify({ name: input.name.trim(), workspace: 'Studio workspace' }));
            store.log('Created the workspace owner account.');
          });
        } else {
          // Perform the same password work even when the email is unknown.
          const valid = await verifyPassword(password, owner?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`);
          requireValue(owner && owner.email === email && valid, 'Email or password is incorrect.', 401);
        }
        const session = createSession(store);
        res.setHeader('Set-Cookie', sessionCookie(session.token, secureCookies));
        return send(res, 200, { authenticated: true, email, csrf: session.csrf });
      }
      if (path === '/api/public/content' && method === 'GET') {
        const entries = store.read().entries.filter(e => e.status === 'Published');
        return send(res, 200, { entries });
      }
      if ((path === '/site' || path.startsWith('/site/')) && method === 'GET') {
        const workspace = store.read();
        const id = path.slice(6);
        const entry = id ? workspace.entries.find(e => e.id === id && e.status === 'Published') : null;
        requireValue(!id || entry, 'This story is not published.', 404);
        return send(res, 200, publicHtml(workspace, entry), 'text/html; charset=utf-8');
      }
      if (path.startsWith('/api/')) {
        const session = getSession(store, req);
        requireValue(session, 'Please sign in to your workspace.', 401);
        if (!['GET', 'HEAD'].includes(method)) requireValue(req.headers['x-csrf-token'] === session.csrf, 'Your session verification expired. Sign in again.', 403);
        if (path === '/api/auth/logout' && method === 'POST') {
          store.db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);
          res.setHeader('Set-Cookie', sessionCookie('', secureCookies, true));
          return send(res, 200, { ok: true });
        }
        if (path === '/api/auth/password' && method === 'POST') {
          throttle(req);
          const input = await body(req);
          const owner = store.db.prepare('SELECT * FROM owner WHERE id=1').get();
          const { password } = credentials({ email: owner.email, password: input.password }, true);
          requireValue(typeof input.currentPassword === 'string' && input.currentPassword.length <= 256, 'Enter your current password.');
          requireValue(await verifyPassword(input.currentPassword, owner.password), 'Current password is incorrect.', 401);
          const hash = await hashPassword(password);
          store.transaction(() => { store.db.prepare('UPDATE owner SET password=? WHERE id=1').run(hash); store.db.exec('DELETE FROM sessions'); store.log('Changed the owner password and revoked all sessions.'); });
          const fresh = createSession(store);
          res.setHeader('Set-Cookie', sessionCookie(fresh.token, secureCookies));
          return send(res, 200, { csrf: fresh.csrf });
        }
        if (path === '/api/workspace' && method === 'GET') return send(res, 200, store.read());
        if (path === '/api/backup' && method === 'GET') {
          res.setHeader('Content-Disposition', `attachment; filename="studio-backup-${new Date().toISOString().slice(0,10)}.json"`);
          return send(res, 200, store.read());
        }
        if (['/api/workspace', '/api/backup'].includes(path) && method === 'PUT') {
          const input = await body(req);
          requireValue(Number.isSafeInteger(input.revision) && input.revision >= 0, 'Workspace revision is required.');
          return send(res, 200, store.save(input, input.revision, path === '/api/backup'));
        }
        throw new HttpError(404, 'API endpoint not found.');
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (files[path] && ['GET', 'HEAD'].includes(method)) {
        const [file, type] = files[path];
        return send(res, 200, method === 'HEAD' ? '' : await readFile(resolve(root, file)), `${type}; charset=utf-8`);
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.message);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'The server could not complete your request. Please try again.' });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  store.publishDue();
  const timer = setInterval(() => { try { store.publishDue(); } catch (error) { console.error('Scheduled publishing failed:', error.message); } }, schedulerMs);
  timer.unref();
  server.on('close', () => { clearInterval(timer); store.close(); });
  return { server, store };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Production requires an HTTPS APP_ORIGIN.');
  const { server } = createApplication({ dbPath: resolve(process.env.DATA_DIR || resolve(root, 'data'), 'studio.sqlite'), origin, secureCookies: origin.startsWith('https://') });
  server.listen(port, host, () => console.log(`Studio CMS running at ${origin}\nPublic stories: ${origin}/site`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}
