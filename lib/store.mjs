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
  const columns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!columns.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  if (!columns.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE users SET role='owner' WHERE id=(SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role='owner');
    CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, email TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, used_at TEXT);
    CREATE TABLE IF NOT EXISTS oauth_states (token TEXT PRIMARY KEY, provider TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), session_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connections (provider TEXT PRIMARY KEY, account TEXT NOT NULL, encrypted_tokens TEXT NOT NULL, updated_at TEXT NOT NULL, last_sync TEXT);
    CREATE TABLE IF NOT EXISTS external_records (provider TEXT NOT NULL, external_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY(provider,external_id,type));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, at TEXT NOT NULL);`);
  return db;
}
export function addUser(db, username, password) {
  if (!/^[a-zA-Z0-9._@-]{2,80}$/.test(username)) throw new Error('Username must contain 2–80 letters, numbers, or . _ @ -');
  if (password.length < 14) throw new Error('Password must contain at least 14 characters');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const role = db.prepare("SELECT id FROM users WHERE role='owner'").get() ? 'member' : 'owner';
  const result = db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(username, `${salt}:${hash}`, role);
  return Number(result.lastInsertRowid);
}
export function authenticate(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  const [salt, stored] = (user?.password ?? 'missing:' + '00'.repeat(64)).split(':');
  const hash = scryptSync(password, salt, 64);
  if (!timingSafeEqual(hash, Buffer.from(stored, 'hex')) || !user) return null;
  return { id: user.id, username: user.username, role: user.role, email: user.email };
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export function setPassword(db, id, password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 1000) throw new Error('Password must contain 14–1000 characters');
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password=? WHERE id=?').run(`${salt}:${scryptSync(password, salt, 64).toString('hex')}`, id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
}
