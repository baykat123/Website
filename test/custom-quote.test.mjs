import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';
import {customQuoteInfo} from '../lib/custom-quote.mjs';
import {packingCode,packingOrderItems} from '../lib/packing-identifiers.mjs';
import {syncOrderDesk} from '../lib/operations.mjs';

const line=(id,units,pieces,part)=>({lineId:`gid://shopify/LineItem/${id}`,sku:'GENERIC-PRINT',barcode:'GENERIC-BAR',title:'Custom 3D Print',quantity:units,financialQuantity:units,unitPriceCents:1,lineTotalCents:units,customAttributes:[{key:'Quote',value:'NEX3D Instant Quote'},{key:'Part',value:part},{key:'Pieces',value:String(pieces)},{key:'Quoted total',value:`CAD $${(units/100).toFixed(2)}`},{key:'Email',value:'customer@example.test'}]});
test('pricing units become verified physical pieces; minimum fees are excluded and ambiguous counts stay blocked',()=>{
  const item=line(2001,600,2,'sample-bracket.stl');assert.equal(customQuoteInfo(item).quantity,2);assert.equal(customQuoteInfo(item).shippingUnitValueCents,300);
  const fee=line(2002,200,0,'Order minimum (CAD $12.00)');assert.equal(customQuoteInfo(fee).serviceCharge,true);assert.equal(packingCode(fee),'');
  assert.equal(customQuoteInfo({...item,quantity:300}).quantity,null);assert.match(customQuoteInfo({...item,quantity:300}).reviewReason,/Partially/);
  assert.equal(customQuoteInfo({...item,customAttributes:item.customAttributes.filter(a=>a.key!=='Pieces')}).quantity,null);
  assert.equal(customQuoteInfo({...item,title:'Ordinary stock item'}).quantity,600);
  const changed=structuredClone(item);changed.quantity=700;changed.financialQuantity=700;changed.lineTotalCents=700;changed.customAttributes.find(a=>a.key==='Quoted total').value='CAD $7.00';assert.equal(packingCode(changed),packingCode(item),'repricing leaves physical job labels unchanged');
});
test('custom quote packing scans physical pieces while retaining fulfillment units and every invoice amount',async()=>{
  const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}}),user={id:addUser(app.db,'owner','physical-piece-test-password'),role:'owner'};
  const fee=line(2001,200,0,'Order minimum (CAD $12.00)'),part=line(2002,600,2,'sample-bracket.stl');
  const snapshot={title:'#SAMPLE-QUOTED',store:'sample.myshopify.com',currency:'CAD',contact:'customer@example.test',financialStatus:'PAID',amount:'8.00',shippingCents:0,taxCents:0,invoiceItems:[fee,part],items:[fee,part]};
  app.db.prepare("INSERT INTO external_records VALUES('shopify','sample-quoted','order',?,'now')").run(JSON.stringify(snapshot));syncOrderDesk(app.db,user);
  const id=app.db.prepare('SELECT id FROM ops_orders').get().id,invoiceId=app.db.prepare('SELECT record_id FROM ops_invoices').get().record_id;
  const invoice=JSON.parse(app.db.prepare('SELECT body FROM records WHERE id=?').get(invoiceId).body);assert.equal(invoice.totalCents,800);assert.match(invoice.items[1].description,/2 pieces/);assert.equal(invoice.items[0].description,'Minimum order adjustment');
  // Reproduce a legacy, untouched generated draft and verify a lossless correction.
  const legacy={...invoice,items:invoice.items.map((i,index)=>({...i,description:`Custom 3D Print (${[200,600][index]} units)`}))};app.db.prepare('UPDATE records SET body=? WHERE id=?').run(JSON.stringify(legacy),invoiceId);syncOrderDesk(app.db,user);
  const repaired=app.db.prepare('SELECT body,version FROM records WHERE id=?').get(invoiceId),history=app.db.prepare('SELECT body FROM ops_invoice_description_history').get();assert.equal(history.body,JSON.stringify(legacy));assert.equal(repaired.version,2);assert.equal(JSON.parse(repaired.body).totalCents,800);assert.deepEqual(JSON.parse(repaired.body).items.map(i=>[i.quantity,i.unitPriceCents]),legacy.items.map(i=>[i.quantity,i.unitPriceCents]));
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';const call=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  try{
    cookie=(await call('/api/login',{username:'owner',password:'physical-piece-test-password'})).cookie;
    const current=(await call('/api/ops/orders')).data.orders[0];assert.equal(current.expectedItems.length,1);assert.equal(current.expectedItems[0].quantity,2);assert.equal(current.serviceLines.length,1);assert.equal(current.body.items[1].quantity,600);
    const rates=(await call(`/api/ops/orders/${id}/rates`,{kg:1,length:20,width:15,height:10})).data.rates,physical=JSON.parse(rates[0].productSnapshot);assert.equal(physical.length,1);assert.equal(physical[0].quantity,2);assert.equal(physical[0].unitPriceCents,300);
    const code=current.expectedItems[0].packingCode;assert.notEqual(code,'GENERIC-PRINT');assert.equal((await call(`/api/ops/orders/${id}/scan`,{sku:'GENERIC-BAR',scanId:'generic'})).status,400);
    assert.equal((await call(`/api/ops/orders/${id}/scan`,{sku:code,scanId:'one'})).status,201);assert.equal((await call(`/api/ops/orders/${id}/book`,{rateId:rates[0].id,approve:true})).status,409);
    assert.equal((await call(`/api/ops/orders/${id}/scan`,{sku:code,scanId:'two'})).status,201);assert.equal((await call('/api/ops/orders')).data.orders[0].packed,true);assert.equal((await call(`/api/ops/orders/${id}/scan`,{sku:code,scanId:'three'})).status,409);
    const stored=JSON.parse(app.db.prepare('SELECT body FROM ops_orders').get().body);assert.deepEqual(stored.items.map(i=>i.quantity),[200,600]);assert.deepEqual(packingOrderItems(stored).map(i=>i.fulfillmentQuantity),[200,600]);
    const repriced=structuredClone(snapshot);repriced.amount='9.00';for(const items of [repriced.items,repriced.invoiceItems]){items[1].quantity=700;items[1].financialQuantity=700;items[1].lineTotalCents=700;items[1].customAttributes.find(a=>a.key==='Quoted total').value='CAD $7.00';}app.db.prepare("UPDATE external_records SET body=? WHERE provider='shopify'").run(JSON.stringify(repriced));syncOrderDesk(app.db,user);assert.equal((await call('/api/ops/orders')).data.orders[0].packed,true,'price-only changes retain physical scan evidence');
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
test('manual invoice edits are preserved instead of being overwritten by quantity-description repair',()=>{
  const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}}),user={id:addUser(app.db,'owner','manual-invoice-test-password'),role:'owner'};
  try{const part=line(2002,600,2,'sample-bracket.stl'),snapshot={title:'#SAMPLE-MANUAL',store:'sample.myshopify.com',currency:'CAD',financialStatus:'PAID',amount:'6.00',shippingCents:0,taxCents:0,invoiceItems:[part],items:[part]};app.db.prepare("INSERT INTO external_records VALUES('shopify','sample-manual','order',?,'now')").run(JSON.stringify(snapshot));syncOrderDesk(app.db,user);const id=app.db.prepare('SELECT record_id FROM ops_invoices').get().record_id,body=JSON.parse(app.db.prepare('SELECT body FROM records WHERE id=?').get(id).body);body.items[0].description='Owner revised description';app.db.prepare('UPDATE records SET body=?,version=2 WHERE id=?').run(JSON.stringify(body),id);syncOrderDesk(app.db,user);assert.equal(app.db.prepare('SELECT body FROM records WHERE id=?').get(id).body,JSON.stringify(body));assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_invoice_description_history').get().n,0);}finally{app.db.close();}
});
