import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openStore, addUser } from '../lib/store.mjs';

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run create-user -- <username> [absolute-password-file-path]');
  process.exit(1);
}
const dbPath = process.env.OPS_DB_PATH ?? '/workspace/.business-operations/operations.sqlite';
const passwordPath = process.argv[3] ?? join(dirname(dbPath), `${username}.password`);
const db = openStore(dbPath);
try {
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) throw new Error('Username already exists; existing account was preserved');
  if (!/^[a-zA-Z0-9._@-]{2,80}$/.test(username)) throw new Error('Invalid username');
  const password = randomBytes(24).toString('base64url');
  writeFileSync(passwordPath, password + '\n', { mode: 0o600, flag: 'wx' });
  addUser(db, username, password);
  chmodSync(dbPath, 0o600);
  console.log(`Created account ${username}. Password stored locally at ${passwordPath}; retrieve securely, never commit or publish it.`);
} finally { db.close(); }
