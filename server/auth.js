import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const hash = await scrypt(password, salt, 64);
  return timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}
export function createSession(store) {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  const expires = Date.now() + 7 * 86400000;
  store.db.prepare('INSERT INTO sessions VALUES(?, ?, ?)').run(digest(token), csrf, expires);
  return { token, csrf, expires };
}
export function getSession(store, req) {
  const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('studio_session='))?.slice(15);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return store.db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(digest(token), Date.now()) || null;
}
export function sessionCookie(token, secure, clear = false) {
  return `studio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 604800}${secure ? '; Secure' : ''}`;
}
