import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';
import {syncOrderDesk} from '../lib/operations.mjs';

test('public support intake preserves privacy and requires owner review with a verified order',async()=>{
  const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}});
  const owner={id:addUser(app.db,'owner','support-test-password'),role:'owner'};
  addUser(app.db,'staff','support-test-password');
  app.db.prepare("INSERT INTO external_records VALUES('shopify','sample-order','order',?,'now')").run(JSON.stringify({store:'sample-store',title:'#SAMPLE-1',items:[{sku:'PART',quantity:1}]}));
  app.db.prepare("INSERT INTO external_records VALUES('gmail','sample-mail','message',?,'now')").run(JSON.stringify({title:'Warranty claim #SAMPLE-1',contact:'Sample <sample@example.test>',notes:'Private warranty details'}));
  syncOrderDesk(app.db,owner);syncOrderDesk(app.db,owner);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM support_intakes').get().n,1);
  const orderId=app.db.prepare('SELECT id FROM ops_orders').get().id;
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const call=async(path,body,headers={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const request={email:'Customer@example.test',subject:'Printer needs repair',details:'Sample case only',category:'warranty',orderReference:'#DOES-NOT-EXIST',serialNumber:'SAMPLE-SERIAL'};
  try{
    assert.equal((await fetch(base+'/support')).status,200);
    assert.equal((await call('/api/support/intakes')).status,401);
    assert.equal((await call('/api/support/request',{...request,email:'invalid'})).status,400);
    assert.equal((await call('/api/support/request',request,{Origin:'https://other.example.test'})).status,403);
    const response=await call('/api/support/request',request);
    assert.equal(response.status,202);assert.deepEqual(Object.keys(response.data),['message']);
    assert.equal((await call('/api/support/request',{...request,website:'spam'})).status,202);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM support_intakes WHERE source='customer_form'").get().n,1);
    cookie=(await call('/api/login',{username:'staff',password:'support-test-password'})).cookie;
    assert.equal((await call('/api/support/intakes')).status,403);
    assert.equal((await call('/api/integrations/records')).data.some(row=>row.provider==='gmail'),false);
    cookie=(await call('/api/login',{username:'owner',password:'support-test-password'})).cookie;
    assert.equal((await call('/api/integrations/records')).data.some(row=>row.provider==='gmail'),true);
    const intake=(await call('/api/support/intakes')).data.find(row=>row.source==='customer_form');
    assert.equal(intake.email,'customer@example.test');
    const url=`/api/support/intakes/${intake.id}/convert`;
    assert.equal((await call(url,{version:1,orderId:9999})).status,400);
    assert.equal((await call(url,{version:99,orderId})).status,409);
    const converted=await call(url,{version:1,orderId});assert.equal(converted.status,200);
    const ticket=app.db.prepare('SELECT * FROM ops_tickets WHERE id=?').get(converted.data.ticketId);
    assert.equal(ticket.order_id,orderId);assert.match(ticket.details,/SAMPLE-SERIAL/);
    assert.equal((await call(url,{version:1,orderId})).status,409);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_tickets').get().n,1);
    cookie='';
    for(let i=0;i<18;i++)assert.equal((await call('/api/support/request',{...request,website:'spam'})).status,202);
    assert.equal((await call('/api/support/request',request)).status,429);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
