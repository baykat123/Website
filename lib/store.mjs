import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), record_id INTEGER NOT NULL REFERENCES records(id), action TEXT NOT NULL, at TEXT NOT NULL);`);
  return db;
}
export function addUser(db, username, password) {
  if (!/^[a-zA-Z0-9._@-]{2,80}$/.test(username)) throw new Error('Username must contain 2–80 letters, numbers, or . _ @ -');
  if (password.length < 14) throw new Error('Password must contain at least 14 characters');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(username, `${salt}:${hash}`);
}
export function authenticate(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  const [salt, stored] = (user?.password ?? 'missing:' + '00'.repeat(64)).split(':');
  const hash = scryptSync(password, salt, 64);
  if (!timingSafeEqual(hash, Buffer.from(stored, 'hex')) || !user) return null;
  return { id: user.id, username: user.username };
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
