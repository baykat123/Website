import { randomBytes } from 'node:crypto';
import { addUser, authenticate, tokenHash, setPassword } from './store.mjs';

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireOwner(user) {
  if (!user) throw new RequestError(401, 'Sign in required');
  if (user.role !== 'owner') throw new RequestError(403, 'Only the workspace owner can do this');
}
export function event(db, user, action) {
  db.prepare('INSERT INTO events(user_id,action,at) VALUES(?,?,?)').run(user.id, action, new Date().toISOString());
}
export function handleTeam({ db, path, req, body, user, json, res }) {
  if (req.method === 'POST' && path === '/api/invites/accept') {
    if (typeof body.token !== 'string' || body.token.length > 100 || typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1000) throw new RequestError(400, 'Invitation, username, and password required');
    const invitation = db.prepare('SELECT * FROM invites WHERE token=? AND expires>? AND used_at IS NULL').get(tokenHash(body.token), Date.now());
    if (!invitation) throw new RequestError(400, 'Invitation expired or already used. Ask the owner for a new link.');
    if (db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(body.username)) throw new RequestError(409, 'Username already exists');
    db.exec('BEGIN IMMEDIATE');
    try {
      const id = addUser(db, body.username, body.password);
      db.prepare("UPDATE users SET email=?,role='member' WHERE id=?").run(invitation.email, id);
      db.prepare('UPDATE invites SET used_at=? WHERE token=?').run(new Date().toISOString(), invitation.token);
      event(db, { id }, 'Joined the workspace');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    json(201, { ok: true }); return true;
  }
  if (path.startsWith('/api/team')) {
    requireOwner(user);
    if (req.method === 'GET' && path === '/api/team') {
      json(200, { users: db.prepare('SELECT id,username,email,role FROM users ORDER BY id').all(), invitations: db.prepare('SELECT email,expires,used_at FROM invites ORDER BY expires DESC LIMIT 30').all() }); return true;
    }
    if (req.method === 'POST' && path === '/api/team/invite') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RequestError(400, 'A valid team email is required');
      if (db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email)) throw new RequestError(409, 'A member with this email already exists');
      const token = randomBytes(32).toString('base64url');
      const expires = Date.now() + 48 * 3600000;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM invites WHERE email=? AND used_at IS NULL').run(email);
        db.prepare('INSERT INTO invites(token,email,created_by,expires) VALUES(?,?,?,?)').run(tokenHash(token), email, user.id, expires);
        event(db, user, `Created an invitation for ${email}`);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      json(201, { path: `/join?token=${encodeURIComponent(token)}`, expires }); return true;
    }
  }
  if (req.method === 'POST' && path === '/api/password') {
    if (!user) throw new RequestError(401, 'Sign in required');
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 1000 || !authenticate(db,user.username,body.currentPassword)) throw new RequestError(400, 'Current password is incorrect');
    db.exec('BEGIN IMMEDIATE');
    try { setPassword(db,user.id,body.newPassword); event(db,user,'Changed password and ended all sessions'); db.exec('COMMIT'); }
    catch(error) { db.exec('ROLLBACK'); throw error; }
    res.setHeader('Set-Cookie','ops_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    json(200,{ok:true}); return true;
  }
  return false;
}
