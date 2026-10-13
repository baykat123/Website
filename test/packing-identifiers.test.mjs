import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';
import {packingCode,shippingProfileKey} from '../lib/packing-identifiers.mjs';
import {syncOrderDesk} from '../lib/operations.mjs';

test('desk labels require actual line identity and do not invent product SKUs',()=>{
  assert.equal(packingCode({sku:' SKU-A '}),'SKU-A');
  assert.equal(packingCode({sku:'',lineId:'gid://shopify/LineItem/1001'}),'OPS-L-1001');
  assert.equal(packingCode({sku:'',title:'Same title'}),'');
  assert.equal(packingCode({sku:'',lineId:'gid://shopify/ProductVariant/1001'}),'');
  const custom={sku:'',lineId:'gid://shopify/LineItem/1001',customAttributes:[{key:'Drawing',value:'A'}]};
  assert.equal(shippingProfileKey(custom),'OPS-L-1001');assert.notEqual(packingCode(custom),shippingProfileKey(custom));
});
test('custom lines sharing a variant stay distinct, require every scan, and retain retired evidence',async()=>{
  const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}});
  const user={id:addUser(app.db,'owner','packing-identifier-test-password'),role:'owner'};
  const first={lineId:'gid://shopify/LineItem/1001',sku:'',variantId:'same-variant',title:'Custom sample part',quantity:1,unitPriceCents:1000,customAttributes:[{key:'Drawing',value:'A'}]},second={...first,lineId:'gid://shopify/LineItem/1002',quantity:2,customAttributes:[{key:'Drawing',value:'B'}]};
  const snapshot={title:'#SAMPLE-LABELS',store:'sample.myshopify.com',currency:'CAD',items:[first,second]};
  app.db.prepare("INSERT INTO external_records VALUES('shopify','sample-label-order','order',?,?)").run(JSON.stringify(snapshot),'now');syncOrderDesk(app.db,user);
  const id=app.db.prepare('SELECT id FROM ops_orders').get().id;
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='';const request=(path,body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const state=async()=>(await (await request('/api/ops/orders')).json()).orders[0];
  const scan=(code,key)=>request(`/api/ops/orders/${id}/scan`,{sku:code,scanId:key});
  try{
    assert.equal((await request(`/api/ops/orders/${id}/labels`)).status,401);
    const login=await request('/api/login',{username:'owner',password:'packing-identifier-test-password'});cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await state()).expectedItems.length,2);assert.equal((await state()).packed,false);
    app.db.prepare('INSERT INTO shipping_products(store,sku,body) VALUES(?,?,?)').run('sample.myshopify.com','OPS-L-1001',JSON.stringify({category:'accessory_no_battery',battery:'none',dangerousGoods:false}));
    const quote=await (await request(`/api/ops/orders/${id}/rates`,{kg:1,length:20,width:15,height:10})).json();assert.equal(JSON.parse(quote.rates[0].productSnapshot)[0].category,'accessory_no_battery','shipping classifications use the stable source-line key, independent of job revision');
    const [aCode,bCode]=(await state()).expectedItems.map(item=>item.packingCode);assert.match(aCode,/^OPS-L-1001-[a-f0-9]{8}$/);assert.match(bCode,/^OPS-L-1002-[a-f0-9]{8}$/);
    const labels=await request(`/api/ops/orders/${id}/labels`);assert.equal(labels.status,200);assert.equal(labels.headers.get('content-type'),'application/pdf');assert.equal(Buffer.from(await labels.arrayBuffer()).subarray(0,4).toString(),'%PDF');assert.equal((await state()).scans.length,0,'printing does not verify packing');
    assert.equal((await scan('same-variant','wrong')).status,400);
    assert.equal((await scan(aCode,'a')).status,201);assert.equal((await scan(aCode,'extra-a')).status,409);assert.equal((await state()).packed,false);
    assert.equal((await scan(bCode,'b1')).status,201);assert.equal((await state()).packed,false);
    assert.equal((await scan(bCode,'b2')).status,201);assert.equal((await state()).packed,true);
    const stored=JSON.parse(app.db.prepare('SELECT body FROM ops_orders').get().body);assert.equal(stored.items[0].sku,'');assert.equal(stored.items[1].sku,'');
    snapshot.items[0].customAttributes=[{key:'Drawing',value:'C'}];app.db.prepare("UPDATE external_records SET body=? WHERE provider='shopify'").run(JSON.stringify(snapshot));syncOrderDesk(app.db,user);
    assert.equal((await state()).packed,false);assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_scans').get().n,3);assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM ops_scans WHERE active=1').get().n,0);
    assert.notEqual((await state()).expectedItems[0].packingCode,aCode);assert.equal((await scan(aCode,'old-label-new-scan')).status,400);
    assert.equal((await scan(bCode,'b1')).status,409);
    snapshot.items.forEach(i=>i.barcode='SHARED-BARCODE');app.db.prepare("UPDATE external_records SET body=? WHERE provider='shopify'").run(JSON.stringify(snapshot));syncOrderDesk(app.db,user);
    assert.equal((await scan('SHARED-BARCODE','ambiguous')).status,409);
    snapshot.items.push({sku:'',title:'Incomplete legacy line',quantity:1});app.db.prepare("UPDATE external_records SET body=? WHERE provider='shopify'").run(JSON.stringify(snapshot));syncOrderDesk(app.db,user);
    assert.equal((await state()).missingIdentifierLines,1);assert.equal((await state()).packed,false);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
