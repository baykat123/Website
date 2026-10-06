import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {openStore,addUser} from '../lib/store.mjs';
import {syncOrderDesk} from '../lib/operations.mjs';

test('order desk retains email notes and tickets, enforces scan quantities, and only simulates approved shipping',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ops-desk-')),path=join(dir,'db.sqlite');
  const app=createApp({dbPath:path});addUser(app.db,'owner','operations-test-password');addUser(app.db,'staff','operations-test-password');
  const snapshot={title:'#SAMPLE-1001',items:[{sku:'PART-A',barcode:'123456',title:'Sample part',quantity:2,unitPriceCents:2500}],amount:'50',currency:'CAD',shippingCents:0,taxCents:0,financialStatus:'PAID'};
  app.db.prepare("INSERT INTO external_records VALUES('shopify','sample-order','order',?,?)").run(JSON.stringify(snapshot),new Date().toISOString());
  app.db.prepare("INSERT INTO external_records VALUES('gmail','sample-email','message',?,?)").run(JSON.stringify({title:'Question about #SAMPLE-1001',contact:'sample@example.com',notes:'Need assistance'}),new Date().toISOString());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const request=async(path,body)=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
  let orderId;
  try{
    assert.equal((await request('/api/ops/orders')).status,401);
    cookie=(await request('/api/login',{username:'staff',password:'operations-test-password'})).cookie;
    assert.equal((await request('/api/ops/import',{})).data.count,1);
    const importedDesk=(await request('/api/ops/orders')).data.orders[0];
    assert.ok(importedDesk.invoice.recordId);
    await request('/api/ops/import',{});
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_invoices').get().n,1);
    orderId=(await request('/api/ops/orders')).data.orders[0].id;const url=`/api/ops/orders/${orderId}`;
    assert.equal((await request(`${url}/email`,{emailId:'sample-email'})).status,403);
    assert.equal((await request('/api/ops/email-suggestions')).status,403);
    cookie=(await request('/api/login',{username:'owner',password:'operations-test-password'})).cookie;
    assert.equal((await request(`${url}/email`,{emailId:'sample-email'})).status,201);
    await request(`${url}/email`,{emailId:'sample-email'});
    cookie=(await request('/api/login',{username:'staff',password:'operations-test-password'})).cookie;
    assert.equal((await request('/api/ops/orders')).data.orders[0].notes.length,1);
    const ticket=(await request(`${url}/ticket`,{title:'Warranty claim',details:'Sample part failed',category:'warranty'})).data;
    assert.equal((await request(`/api/ops/tickets/${ticket.id}`,{version:1,status:'waiting_supplier',note:'Awaiting response',assignee:'staff'})).status,200);
    assert.equal((await request(`/api/ops/tickets/${ticket.id}`,{version:1,status:'resolved',note:'Stale update'})).status,409);
    assert.equal((await request(`${url}/scan`,{sku:'WRONG',scanId:'wrong'})).status,400);
    const rates=(await request(`${url}/rates`,{kg:2,length:30,width:20,height:15})).data.rates;
    assert.ok(rates[0].priceCents<=rates[1].priceCents);
    assert.equal((await request(`${url}/book`,{rateId:rates[0].id,approve:true})).status,403);
    cookie=(await request('/api/login',{username:'owner',password:'operations-test-password'})).cookie;
    assert.equal((await request(`${url}/book`,{rateId:rates[0].id,approve:true})).status,409);
    assert.equal((await request(`${url}/scan`,{sku:'123456',scanId:'scan-one'})).status,201);
    assert.equal((await request(`${url}/scan`,{sku:'123456',scanId:'scan-one'})).data.duplicate,true);
    assert.equal((await request(`${url}/scan`,{sku:'PART-A',scanId:'scan-two'})).status,201);
    assert.equal((await request(`${url}/scan`,{sku:'PART-A',scanId:'scan-three'})).status,409);
    assert.equal((await request('/api/ops/orders')).data.orders[0].packed,true);
    assert.equal((await request(`${url}/book`,{rateId:rates[0].id})).status,400);
    app.db.prepare('UPDATE ops_orders SET body=? WHERE id=?').run(JSON.stringify({...snapshot,cancelledAt:'2026-10-06'}),orderId);
    assert.equal((await request(`${url}/book`,{rateId:rates[0].id,approve:true})).status,409);
    app.db.prepare('UPDATE ops_orders SET body=? WHERE id=?').run(JSON.stringify(snapshot),orderId);
    const shipment=(await request(`${url}/book`,{rateId:rates[0].id,approve:true})).data;
    assert.equal(shipment.status,'simulated');assert.match(shipment.tracking,/^SIM-/);
    assert.equal((await request(`${url}/book`,{rateId:rates[0].id,approve:true})).data.id,shipment.id);
    assert.equal((await request(`${url}/scan`,{sku:'PART-A',scanId:'after-booking'})).status,409);
    app.db.prepare("DELETE FROM external_records WHERE provider='gmail'").run();
    app.db.prepare("DELETE FROM external_records WHERE provider='shopify'").run();
    await request('/api/ops/import',{});
    assert.equal((await request('/api/ops/orders')).data.orders[0].notes.filter(n=>n.kind==='email').length,1);
    assert.equal((await request('/api/ops/tickets')).data.length,1);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
  const restored=openStore(path);try{assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM ops_tickets').get().n,1);assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM ops_shipments').get().n,1);}finally{restored.close();rmSync(dir,{recursive:true,force:true});}
});

test('order changes retire scan evidence without erasing it; price-only changes retain verified units',async()=>{
  const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}});
  const user={id:addUser(app.db,'owner','scan-evidence-password'),role:'owner'};
  let snapshot={title:'#SAMPLE-SCAN',items:[{sku:'PART-A',barcode:'BAR-A',quantity:1,unitPriceCents:100}]};
  const save=()=>app.db.prepare("INSERT INTO external_records VALUES('shopify','scan-order','order',?,'now') ON CONFLICT(provider,external_id,type) DO UPDATE SET body=excluded.body").run(JSON.stringify(snapshot));
  save();syncOrderDesk(app.db,user);
  const id=app.db.prepare('SELECT id FROM ops_orders').get().id;
  app.db.prepare("INSERT INTO ops_scans(order_id,sku,scan_key,user_id,at) VALUES(?,'PART-A','original',?,'now')").run(id,user.id);
  try{
    snapshot={...snapshot,items:[{...snapshot.items[0],unitPriceCents:200}]};save();syncOrderDesk(app.db,user);
    assert.equal(app.db.prepare('SELECT active FROM ops_scans').get().active,1);
    snapshot={...snapshot,items:[{...snapshot.items[0],quantity:2}]};save();syncOrderDesk(app.db,user);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_scans').get().n,1);
    assert.equal(app.db.prepare('SELECT active FROM ops_scans').get().active,0);
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'scan-evidence-password'})});
    const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]};
    const scan=scanId=>fetch(`${base}/api/ops/orders/${id}/scan`,{method:'POST',headers,body:JSON.stringify({sku:'BAR-A',scanId})});
    assert.equal((await scan('original')).status,409);
    assert.equal((await scan('replacement')).status,201);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_scans').get().n,2);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_scans WHERE active=1').get().n,1);
  }finally{if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
