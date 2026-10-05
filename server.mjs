import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openStore, authenticate, tokenHash } from './lib/store.mjs';
import { validateRecord, editableBody } from './lib/records.mjs';

const publicFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const decodeRow = row => row && ({ ...row, body: JSON.parse(row.body) });
export function createApp({ dbPath, secureCookies = false } = {}) {
  const db = openStore(dbPath ?? process.env.OPS_DB_PATH ?? '/workspace/.business-operations/operations.sqlite');
  const loginAttempts = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && publicFiles[path]) {
        const [file, type] = publicFiles[path];
        res.writeHead(200, { 'Content-Type': type });
        return res.end(readFileSync(new URL(`./public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/health') return json(200, { status: 'ok' });
      let body;
      if (['POST', 'PATCH'].includes(req.method)) {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'JSON required' });
        if (req.headers.origin && req.headers.origin !== `${secureCookies ? 'https' : 'http'}://${req.headers.host}`) return json(403, { error: 'Invalid request origin' });
        let data = '';
        for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 128000) return json(413, { error: 'Request too large' }); }
        try { body = JSON.parse(data); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'JSON object required' });
      }
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ops_session='))?.slice(12);
      const user = cookie && db.prepare('SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(tokenHash(cookie), Date.now());
      if (req.method === 'POST' && path === '/api/login') {
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1000 || body.username.length > 80) return json(400, { error: 'Username and password required' });
        const key = req.socket.remoteAddress;
        const now = Date.now();
        for (const [address, attempt] of loginAttempts) if (attempt.until < now) loginAttempts.delete(address);
        const attempt = loginAttempts.get(key) ?? { count: 0, until: now + 600000 };
        if (attempt.count >= 10) return json(429, { error: 'Too many attempts. Try again in 10 minutes.' });
        const found = authenticate(db, body.username, body.password);
        if (!found) { attempt.count++; loginAttempts.set(key, attempt); return json(401, { error: 'Invalid username or password' }); }
        loginAttempts.delete(key);
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(tokenHash(token), found.id, now + 28800000);
        res.setHeader('Set-Cookie', `ops_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? '; Secure' : ''}`);
        return json(200, found);
      }
      if (!user) return json(401, { error: 'Sign in required' });
      if (req.method === 'GET' && path === '/api/me') return json(200, user);
      if (req.method === 'POST' && path === '/api/logout') {
        db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(cookie));
        res.setHeader('Set-Cookie', 'ops_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/records') return json(200, db.prepare('SELECT * FROM records ORDER BY updated_at DESC,id DESC').all().map(decodeRow));
      if (req.method === 'GET' && path === '/api/audit') return json(200, db.prepare('SELECT audit.*,users.username FROM audit JOIN users ON users.id=audit.user_id ORDER BY audit.id DESC LIMIT 100').all());
      const now = new Date().toISOString();
      function insert(type, data, action = 'created') {
        db.exec('BEGIN IMMEDIATE');
        try {
          const id = Number(db.prepare('INSERT INTO records(type,body,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(type, JSON.stringify(data), user.id, user.id, now, now).lastInsertRowid);
          db.prepare('INSERT INTO audit(user_id,record_id,action,at) VALUES(?,?,?,?)').run(user.id, id, action, now);
          db.exec('COMMIT');
          return decodeRow(db.prepare('SELECT * FROM records WHERE id=?').get(id));
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      if (req.method === 'POST' && path === '/api/records') {
        const data = validateRecord(body.type, { ...body, status: undefined });
        return json(201, insert(body.type, data));
      }
      const match = path.match(/^\/api\/records\/(\d+)(?:\/(status|convert))?$/);
      if (req.method === 'POST' && match) {
        const record = decodeRow(db.prepare('SELECT * FROM records WHERE id=?').get(Number(match[1])));
        if (!record) return json(404, { error: 'Record not found' });
        if (body.version !== record.version) return json(409, { error: 'This record changed. Refresh before trying again.' });
        if (!match[2]) {
          if (!['draft', 'open', 'in_progress', 'ordered', 'shipped'].includes(record.body.status)) return json(400, { error: 'Return to draft before editing a reviewed record; completed records cannot be edited' });
          const data = validateRecord(record.type, { ...body, status: record.body.status });
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('UPDATE records SET body=?,updated_by=?,updated_at=?,version=version+1 WHERE id=?').run(JSON.stringify(data),user.id,now,record.id);
            db.prepare('INSERT INTO audit(user_id,record_id,action,at) VALUES(?,?,?,?)').run(user.id,record.id,'edited',now);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          return json(200,decodeRow(db.prepare('SELECT * FROM records WHERE id=?').get(record.id)));
        }
        if (match[2] === 'convert') {
          const target = record.type === 'quote' ? 'order' : record.type === 'order' ? 'invoice' : null;
          if (!target || !['approved', 'fulfilled'].includes(record.body.status)) return json(400, { error: 'Approve the quote or order before converting it' });
          // Preserve totals but create a new draft; no external order is placed.
          const data = validateRecord(target, { ...editableBody(record.body), status: 'draft', notes: `${record.body.notes}\nCreated from ${record.type} #${record.id}`.trim() });
          return json(201, insert(target, data, `created from ${record.type} #${record.id}`));
        }
        if (match[2] === 'status') {
          const transitions = { draft: ['pending_review'], pending_review: ['approved', 'draft'], approved: record.type === 'order' ? ['fulfilled'] : record.type === 'invoice' ? ['paid'] : [], open: record.type === 'task' ? ['in_progress', 'done'] : ['ordered'], in_progress: ['done'], ordered: ['shipped'], shipped: ['delivered'], done: ['open'] };
          if (!(transitions[record.body.status] ?? []).includes(body.status)) return json(400, { error: 'Invalid status transition' });
          const data = validateRecord(record.type, { ...editableBody(record.body), status: body.status });
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('UPDATE records SET body=?,updated_by=?,updated_at=?,version=version+1 WHERE id=?').run(JSON.stringify(data), user.id, now, record.id);
            db.prepare('INSERT INTO audit(user_id,record_id,action,at) VALUES(?,?,?,?)').run(user.id, record.id, `status: ${record.body.status} → ${body.status}`, now);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          return json(200, decodeRow(db.prepare('SELECT * FROM records WHERE id=?').get(record.id)));
        }
      }
      return json(404, { error: 'Not found' });
    } catch (error) {
      if (/required|Invalid|Unknown|must|Amounts|Each item|Add between|limit|currency/.test(error.message)) return json(400, { error: error.message });
      console.error('Request failed:', error.message);
      return json(500, { error: 'Unable to complete the request' });
    }
  });
  return { server, db };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createApp({ secureCookies: process.env.OPS_SECURE_COOKIES === 'true' });
  const host = process.env.OPS_HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, host, () => console.log(`Operations server listening on ${host}:${port}`));
}
