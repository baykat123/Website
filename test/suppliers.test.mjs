import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';

const draft={title:'SAMPLE: Inbound parts',supplier:'prm',currency:'CAD',sampleData:true,items:[{sku:'PART-A',supplierSku:'SUP-A',title:'Sample part',barcode:'BAR-A',quantity:2,unitCostCents:1250}]};
async function setup(){const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}});addUser(app.db,'owner','supplier-test-password');addUser(app.db,'staff','supplier-test-password');await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));let cookie='';const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,body)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  return {app,call,login:async username=>{cookie=(await call('/api/login',{username,password:'supplier-test-password'})).cookie;},close:async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();}};
}
test('purchase drafts retain exact review revisions, never submit without API access, and revoke approval on edit',async()=>{
  const {app,call,login,close}=await setup();
  try{
    assert.equal((await call('/api/supplier-orders')).status,401);await login('staff');
    assert.equal((await call('/api/supplier-orders',{...draft,expectedDate:'2026-02-31'})).status,400);
    assert.equal((await call('/api/supplier-orders',{...draft,items:[...draft.items,...draft.items]})).status,400);
    const order=(await call('/api/supplier-orders',{...draft,sampleData:false})).data,url=`/api/supplier-orders/${order.id}`;
    assert.equal(order.body.totalCents,2500);assert.equal((await call(`${url}/submit`,{version:1})).status,200);
    assert.equal((await call(`${url}/approve`,{version:2})).status,403);await login('owner');
    assert.equal((await call(`${url}/approve`,{version:1})).status,409);
    assert.equal((await call(`${url}/approve`,{version:2})).data.status,'approved');
    assert.equal((await call(`${url}/simulate`,{version:3})).status,409);
    assert.equal((await call(`${url}/edit`,{version:3,payload:{...draft,sampleData:true}})).status,409);
    assert.equal((await call(`${url}/edit`,{version:3,payload:{...draft,sampleData:false,notes:'Corrected purchase details'}})).data.status,'draft');
    assert.equal((await call(`${url}/receive`,{code:'PART-A',condition:'good',scanId:'live-receipt'})).status,409);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM supplier_receipts').get().n,0);
    assert.equal((await call('/api/supplier-orders')).data.apiStatus,'pending');
    const history=(await call('/api/supplier-orders')).data.orders[0].history;
    assert.equal(history.length,4);assert.equal(history[2].status,'approved');assert.equal(history[2].body.notes,'');assert.equal(history[3].body.notes,'Corrected purchase details');
  }finally{await close();}
});
test('sample inbound scanning retains staff/serial evidence, rejects duplicate serials and excess units, and counts damage separately',async()=>{
  const {app,call,login,close}=await setup();
  try{await login('owner');const order=(await call('/api/supplier-orders',draft)).data,url=`/api/supplier-orders/${order.id}`;
    await call(`${url}/submit`,{version:1});await call(`${url}/approve`,{version:2});assert.equal((await call(`${url}/simulate`,{version:3})).data.status,'simulated');await login('staff');
    const good={code:'BAR-A',condition:'good',scanId:'one',serialNumber:'SAMPLE-1',note:''};
    assert.equal((await call(`${url}/receive`,{...good,code:'WRONG'})).status,400);
    assert.equal((await call(`${url}/receive`,good)).status,201);
    assert.equal((await call(`${url}/receive`,good)).data.duplicate,true);
    assert.equal((await call(`${url}/receive`,{...good,condition:'damaged',note:'Changed evidence'})).status,409);
    assert.equal((await call(`${url}/receive`,{...good,scanId:'duplicate-serial'})).status,409);
    const damaged={code:'PART-A',condition:'damaged',scanId:'two',serialNumber:'SAMPLE-2'};
    assert.equal((await call(`${url}/receive`,damaged)).status,400);
    const received=await call(`${url}/receive`,{...damaged,note:'Sample damage recorded'});assert.equal(received.data.status,'received_sample');
    assert.equal((await call(`${url}/receive`,{...good,scanId:'over',serialNumber:'SAMPLE-3'})).status,409);
    assert.equal(received.data.receipts.length,2);assert.equal(received.data.receipts.filter(row=>row.condition==='good').length,1);
    assert.equal(received.data.receipts.every(row=>row.username==='staff'),true);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_shipments').get().n,0);
  }finally{await close();}
});
test('USA supplier preparation checks source store/quantities and blocks approval after the customer order changes',async()=>{
  const {app,call,login,close}=await setup();
  try{await login('owner');const snapshot={title:'#SAMPLE-USA',sampleData:true,currency:'USD',items:[{sku:'PART-A',quantity:2}],financialStatus:'PAID',fulfillmentStatus:'UNFULFILLED'};
    const id=Number(app.db.prepare("INSERT INTO ops_orders(store,external_id,body,updated_at) VALUES('sample-usa','sample-1',?,'now')").run(JSON.stringify(snapshot)).lastInsertRowid);
    const input={...draft,supplier:'usa',currency:'USD',sourceOrderId:id};
    assert.equal((await call('/api/supplier-orders',{...input,supplier:'prm'})).status,400);
    assert.equal((await call('/api/supplier-orders',{...input,items:[{...draft.items[0],quantity:1}]})).status,409);
    const order=(await call('/api/supplier-orders',input)).data,url=`/api/supplier-orders/${order.id}`;
    assert.equal((await call('/api/supplier-orders',input)).status,409);
    assert.equal(order.body.customerOrder.store,'sample-usa');await call(`${url}/submit`,{version:1});
    app.db.prepare('UPDATE ops_orders SET body=? WHERE id=?').run(JSON.stringify({...snapshot,cancelledAt:'now'}),id);
    assert.equal((await call(`${url}/approve`,{version:2})).status,409);
    app.db.prepare('UPDATE ops_orders SET body=? WHERE id=?').run(JSON.stringify({...snapshot,sampleData:false}),id);
    assert.equal((await call('/api/supplier-orders',{...input,sampleData:false})).status,409);
  }finally{await close();}
});
