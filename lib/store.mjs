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
  db.exec(`CREATE TABLE IF NOT EXISTS record_links (
    source_id INTEGER PRIMARY KEY REFERENCES records(id),
    target_id INTEGER UNIQUE NOT NULL REFERENCES records(id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES records(id), kind TEXT NOT NULL,
    original TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL, operation_key TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS proposal_feedback (
    id INTEGER PRIMARY KEY, proposal_id INTEGER NOT NULL REFERENCES proposals(id), user_id INTEGER NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS ops_orders (id INTEGER PRIMARY KEY,store TEXT NOT NULL,external_id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(store,external_id));
  CREATE TABLE IF NOT EXISTS ops_notes (id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES ops_orders(id),user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,content TEXT NOT NULL,email_id TEXT,created_at TEXT NOT NULL,UNIQUE(order_id,email_id));
  CREATE TABLE IF NOT EXISTS ops_emails (order_id INTEGER NOT NULL REFERENCES ops_orders(id),external_id TEXT NOT NULL,snapshot TEXT NOT NULL,linked_by INTEGER NOT NULL REFERENCES users(id),linked_at TEXT NOT NULL,PRIMARY KEY(order_id,external_id));
  CREATE TABLE IF NOT EXISTS ops_tickets (id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES ops_orders(id),title TEXT NOT NULL,details TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL,assignee TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ops_scans (id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES ops_orders(id),sku TEXT NOT NULL,scan_key TEXT UNIQUE NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ops_rates (id TEXT PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES ops_orders(id),body TEXT NOT NULL,expires INTEGER NOT NULL,quote_key TEXT NOT NULL,order_snapshot TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ops_shipments (id INTEGER PRIMARY KEY,order_id INTEGER UNIQUE NOT NULL REFERENCES ops_orders(id),provider TEXT NOT NULL,service TEXT NOT NULL,price_cents INTEGER NOT NULL,currency TEXT NOT NULL,tracking TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS ops_invoices (order_id INTEGER PRIMARY KEY REFERENCES ops_orders(id),record_id INTEGER UNIQUE NOT NULL REFERENCES records(id),order_snapshot TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS saved_packages(id INTEGER PRIMARY KEY,name TEXT NOT NULL,body TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS active_package_names ON saved_packages(name COLLATE NOCASE) WHERE archived=0;`);
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_origins(store TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ops_booking_jobs(id INTEGER PRIMARY KEY,order_id INTEGER UNIQUE NOT NULL REFERENCES ops_orders(id),body TEXT NOT NULL,order_snapshot TEXT NOT NULL,operation_key TEXT UNIQUE NOT NULL,status TEXT NOT NULL,approved_by INTEGER NOT NULL REFERENCES users(id),external_id TEXT,error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);`);
  const shipmentColumns=db.prepare('PRAGMA table_info(ops_shipments)').all().map(row=>row.name);
  for(const name of ['external_id','label_url','tracking_url','fulfillment_status'])if(!shipmentColumns.includes(name))db.exec(`ALTER TABLE ops_shipments ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  db.exec(`CREATE TABLE IF NOT EXISTS ops_email_decisions(order_id INTEGER NOT NULL REFERENCES ops_orders(id),email_id TEXT NOT NULL,decision TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),at TEXT NOT NULL,PRIMARY KEY(order_id,email_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS provider_health(provider TEXT PRIMARY KEY,status TEXT NOT NULL,message TEXT NOT NULL,checked_at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_products(store TEXT NOT NULL,sku TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,sku));`);
  db.exec(`CREATE TABLE IF NOT EXISTS ops_booking_history(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES ops_booking_jobs(id),body TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS support_intakes(id TEXT PRIMARY KEY,source TEXT NOT NULL,email_id TEXT UNIQUE,email TEXT NOT NULL,subject TEXT NOT NULL,details TEXT NOT NULL,serial_number TEXT NOT NULL,order_reference TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,ticket_id INTEGER REFERENCES ops_tickets(id),created_at TEXT NOT NULL);`);
  const scanColumns=db.prepare('PRAGMA table_info(ops_scans)').all().map(row=>row.name);if(!scanColumns.includes('active'))db.exec('ALTER TABLE ops_scans ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  db.exec(`CREATE TABLE IF NOT EXISTS supplier_orders(id INTEGER PRIMARY KEY,supplier TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,source_order_id INTEGER REFERENCES ops_orders(id),created_by INTEGER NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supplier_receipts(id INTEGER PRIMARY KEY,supplier_order_id INTEGER NOT NULL REFERENCES supplier_orders(id),sku TEXT NOT NULL,scan_key TEXT UNIQUE NOT NULL,serial_number TEXT,condition TEXT NOT NULL,note TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supplier_order_versions(supplier_order_id INTEGER NOT NULL REFERENCES supplier_orders(id),version INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(supplier_order_id,version));
    CREATE UNIQUE INDEX IF NOT EXISTS active_supplier_sources ON supplier_orders(source_order_id) WHERE source_order_id IS NOT NULL AND status!='rejected';
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_receipt_serials ON supplier_receipts(serial_number) WHERE serial_number IS NOT NULL;`);
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
