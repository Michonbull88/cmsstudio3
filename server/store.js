import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError, workspace } from './validation.js';

export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, status TEXT NOT NULL, publish_date TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS publishing_dates ON entries(status, publish_date);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, date TEXT NOT NULL, text TEXT NOT NULL);
    PRAGMA user_version=1;`);
  db.prepare('INSERT OR IGNORE INTO workspace VALUES(1, 0, ?)').run(JSON.stringify({ name: 'Workspace owner', workspace: 'Studio workspace' }));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function log(text) {
    db.prepare('INSERT INTO activity VALUES(?, ?, ?)').run(randomUUID(), new Date().toISOString(), text.slice(0, 1000));
    db.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY rowid DESC LIMIT 150)');
  }
  function read() {
    const meta = db.prepare('SELECT * FROM workspace WHERE id=1').get();
    return { version: 1, revision: meta.revision, settings: JSON.parse(meta.settings),
      entries: db.prepare('SELECT data FROM entries ORDER BY rowid DESC').all().map(r => JSON.parse(r.data)),
      media: db.prepare('SELECT data FROM media ORDER BY rowid DESC').all().map(r => JSON.parse(r.data)),
      activity: db.prepare('SELECT id, date, text FROM activity ORDER BY rowid DESC').all() };
  }
  function save(input, expectedRevision, importing = false) {
    const next = workspace(input);
    return transaction(() => {
      const previous = read();
      if (previous.revision !== expectedRevision) throw new HttpError(409, 'The workspace changed in another session. Refresh the workspace before trying again.');
      const oldEntries = new Map(previous.entries.map(e => [e.id, e]));
      const timestamp = new Date().toISOString();
      const insertEntry = db.prepare('INSERT INTO entries VALUES(?, ?, ?, ?)');
      db.exec('DELETE FROM entries');
      for (const e of next.entries) {
        const old = oldEntries.get(e.id);
        const changed = !old || JSON.stringify({ ...old, updated: '' }) !== JSON.stringify({ ...e, updated: '' });
        if (!importing && changed && e.status === 'Scheduled' && e.date <= timestamp) throw new HttpError(400, 'Choose a future date for scheduled content.');
        if (changed) { e.updated = timestamp; if (!importing) log(`${old ? 'Updated' : 'Created'} “${e.title}” · ${e.status.toLowerCase()}.`); }
        else e.updated = old.updated;
        insertEntry.run(e.id, e.status, e.date, JSON.stringify(e));
        oldEntries.delete(e.id);
      }
      if (!importing) for (const e of oldEntries.values()) log(`Deleted “${e.title}”.`);
      db.exec('DELETE FROM media');
      const insertMedia = db.prepare('INSERT INTO media VALUES(?, ?)');
      for (const m of next.media) { insertMedia.run(m.id, JSON.stringify(m)); if (!importing && !previous.media.some(o => o.id === m.id)) log(`Uploaded “${m.name}”.`); }
      if (!importing) for (const m of previous.media) if (!next.media.some(n => n.id === m.id)) log(`Removed media “${m.name}”.`);
      if (importing) log('Restored content, media, and workspace details from a backup.');
      else if (JSON.stringify(previous.settings) !== JSON.stringify(next.settings)) log('Updated workspace details.');
      db.prepare('UPDATE workspace SET revision=revision+1, settings=? WHERE id=1').run(JSON.stringify(next.settings));
      return read();
    });
  }
  function publishDue() {
    return transaction(() => {
      const timestamp = new Date().toISOString();
      const due = db.prepare("SELECT data FROM entries WHERE status='Scheduled' AND publish_date<=?").all(timestamp);
      for (const row of due) {
        const e = { ...JSON.parse(row.data), status: 'Published', updated: timestamp };
        db.prepare('UPDATE entries SET status=?, data=? WHERE id=?').run(e.status, JSON.stringify(e), e.id);
        log(`Published scheduled content “${e.title}”.`);
      }
      if (due.length) db.exec('UPDATE workspace SET revision=revision+1 WHERE id=1');
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      return due.length;
    });
  }
  return { db, read, save, log, publishDue, transaction, close: () => db.close() };
}
