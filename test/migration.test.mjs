import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import { openStore, authenticate } from '../lib/store.mjs';

test('upgrading the original database preserves passwords and records and assigns only the first user as owner',()=>{
  const dir=mkdtempSync(join(tmpdir(),'operations-migration-')),path=join(dir,'legacy.sqlite');
  let db=new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
      CREATE TABLE records (id INTEGER PRIMARY KEY,type TEXT NOT NULL,body TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);`);
    const password='legacy-test-only-password',salt='test-legacy-salt',hash=scryptSync(password,salt,64).toString('hex');
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(1,'kamal',`${salt}:${hash}`);
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(2,'existing-member',`${salt}:${hash}`);
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(1,'task',JSON.stringify({title:'Existing customer work',status:'open'}),1,1,'2026-10-04','2026-10-04',4);
    db.close();db=openStore(path);
    assert.equal(authenticate(db,'kamal',password).role,'owner');
    assert.equal(authenticate(db,'existing-member',password).role,'member');
    const record=db.prepare('SELECT * FROM records WHERE id=1').get();
    assert.equal(JSON.parse(record.body).title,'Existing customer work');assert.equal(record.version,4);
    db.close();db=openStore(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='owner'").get().count,1);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
