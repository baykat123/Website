import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { addUser } from '../lib/store.mjs';

test('shared sales workflow enforces login, review, exact totals, concurrency, audit, and persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-test-'));
  const dbPath = join(dir,'test.sqlite');
  let app = createApp({ dbPath });
  const password = 'test-only-strong-password-2026';
  addUser(app.db,'alice',password); addUser(app.db,'bob',password);
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const request = async (path, body, options = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...(cookie ? { Cookie:cookie } : {}), ...options }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie:response.headers.get('set-cookie') };
  };
  try {
    assert.equal((await request('/api/records')).status,401);
    assert.equal((await request('/api/login',{username:'alice',password:'wrong'})).status,401);
    const login = await request('/api/login',{username:'alice',password});
    assert.equal(login.status,200); assert.match(login.cookie,/HttpOnly/); assert.match(login.cookie,/SameSite=Lax/);
    cookie = login.cookie.split(';')[0];
    assert.equal((await request('/api/records',{type:'task',title:'Forged'},{Origin:'https://attacker.example'})).status,403);
    assert.equal((await request('/api/records',{type:'quote',title:'Invalid cents',items:[{description:'Part',quantity:1,unitPrice:'1.001'}]})).status,400);
    assert.equal((await request('/api/records',{type:'task',title:'Invalid date',due:'2026-02-30'})).status,400);
    const quote = await request('/api/records',{type:'quote',title:'Customer quote',contact:'Customer A',currency:'USD',items:[{description:'Part',quantity:3,unitPrice:'0.10'},{description:'Equipment',quantity:2,unitPrice:'125.95'}],shipping:'12.50',tax:'20.15',totalCents:1,status:'approved'});
    assert.equal(quote.status,201); assert.equal(quote.body.body.totalCents,28485); assert.equal(quote.body.body.status,'draft');
    const id = quote.body.id;
    assert.equal((await request(`/api/records/${id}/convert`,{version:1})).status,400);
    assert.equal((await request(`/api/records/${id}/status`,{version:1,status:'approved'})).status,400);
    const submitted = await request(`/api/records/${id}/status`,{version:1,status:'pending_review'});
    assert.equal(submitted.status,200);
    assert.equal((await request(`/api/records/${id}/status`,{version:1,status:'approved'})).status,409);
    const bob = await request('/api/login',{username:'bob',password}); cookie = bob.cookie.split(';')[0];
    assert.equal((await request('/api/records')).body.length,1);
    const approved = await request(`/api/records/${id}/status`,{version:2,status:'approved'});
    assert.equal(approved.status,200);
    assert.equal((await request(`/api/records/${id}`,{version:3,title:'Changed after approval'})).status,400);
    const order = await request(`/api/records/${id}/convert`,{version:3});
    const repeatedOrder = await request(`/api/records/${id}/convert`,{version:3});
    assert.equal(repeatedOrder.status,200); assert.equal(repeatedOrder.body.id,order.body.id);
    assert.equal(order.status,201); assert.equal(order.body.type,'order'); assert.equal(order.body.body.totalCents,28485); assert.equal(order.body.body.status,'draft');
    await request(`/api/records/${order.body.id}/status`,{version:1,status:'pending_review'});
    await request(`/api/records/${order.body.id}/status`,{version:2,status:'approved'});
    assert.equal((await request(`/api/records/${order.body.id}/status`,{version:3,status:'fulfilled'})).status,400);
    const invoice = await request(`/api/records/${order.body.id}/convert`,{version:3});
    const repeatedInvoice = await request(`/api/records/${order.body.id}/convert`,{version:3});
    assert.equal(repeatedInvoice.status,200); assert.equal(repeatedInvoice.body.id,invoice.body.id);
    const linkedRecords = (await request('/api/records')).body;
    assert.equal(linkedRecords.find(r=>r.id===id).target_id,order.body.id);
    assert.equal(linkedRecords.find(r=>r.id===invoice.body.id).source_id,order.body.id);
    assert.equal(invoice.status,201); assert.equal(invoice.body.type,'invoice'); assert.equal(invoice.body.body.totalCents,28485);
    const task = await request('/api/records',{type:'task',title:'Follow up',due:'2026-12-01'});
    assert.equal((await request(`/api/records/${task.body.id}`,{version:1,title:'Follow up tomorrow',due:'2026-12-02',assignee:'bob',status:'done'})).body.body.status,'open');
    assert.equal((await request(`/api/records/${task.body.id}/status`,{version:2,status:'done'})).status,200);
    const message = await request('/api/records',{type:'message',title:'Draft reply',notes:'<script>alert(1)</script>'});
    assert.equal(message.body.body.status,'draft');
    const shipment = await request('/api/records',{type:'shipment',title:'US direct ship',supplier:'Supplier',tracking:'TRACK-123'});
    assert.equal((await request(`/api/records/${shipment.body.id}/status`,{version:1,status:'delivered'})).status,400);
    assert.equal((await request(`/api/records/${shipment.body.id}/status`,{version:1,status:'ordered'})).status,200);
    assert.equal((await request(`/api/records/${shipment.body.id}/status`,{version:2,status:'shipped'})).status,200);
    assert.equal((await request(`/api/records/${shipment.body.id}/status`,{version:3,status:'delivered'})).status,200);
    const audit = (await request('/api/audit')).body;
    assert.ok(audit.some(event => event.username === 'bob' && event.action === 'status: pending_review → approved'));
    assert.equal((await request('/api/logout',{})).status,200);
    assert.equal((await request('/api/records')).status,401);
    await new Promise(resolve => app.server.close(resolve)); app.db.close();
    app = createApp({ dbPath });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM record_links').get().count,2);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM records').get().count,6);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM users').get().count,2);
  } finally {
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    app.db.close(); rmSync(dir,{recursive:true,force:true});
  }
});

test('login throttling rejects repeated invalid credentials', async () => {
  const app = createApp({ dbPath:':memory:' });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  try {
    const url = `http://127.0.0.1:${app.server.address().port}/api/login`;
    for (let i=0;i<10;i++) assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'unknown',password:'invalid'})})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'unknown',password:'invalid'})})).status,429);
  } finally { await new Promise(resolve => app.server.close(resolve)); app.db.close(); }
});
