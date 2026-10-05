import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openStore, authenticate } from '../lib/store.mjs';

test('provisioning works beside a configured persistent database and preserves existing accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-provision-'));
  const path = join(dir, 'data', 'operations.sqlite');
  const passwordPath = join(dir, 'data', 'team-user.password');
  const script = new URL('../scripts/create-user.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [script.pathname, 'team-user'], { env: { ...process.env, OPS_DB_PATH: path }, encoding: 'utf8' });
  let db;
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const password = readFileSync(passwordPath, 'utf8').trim();
    assert.ok(password.length >= 14);
    assert.equal(statSync(passwordPath).mode & 0o777, 0o600);
    assert.ok(!first.stdout.includes(password));
    db = openStore(path);
    assert.equal(authenticate(db, 'team-user', password).username, 'team-user');
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(passwordPath, 'utf8').trim(), password);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
