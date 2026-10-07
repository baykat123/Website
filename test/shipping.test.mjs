import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createShipping} from '../lib/shipping.mjs';
import {createShippingJobs} from '../lib/shipping-jobs.mjs';
import {openStore,addUser} from '../lib/store.mjs';
const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const address={name:'Sample Customer',companyName:'Sample Company',address1:'100 Sample Street',city:'Toronto',provinceCode:'ON',countryCodeV2:'CA',zip:'M5V 1A1',phone:'4165550100',email:'sample@example.test'};
const order={id:1,store:'sample.myshopify.com',body:{title:'#1001',currency:'CAD',contact:address.email,shippingAddress:address,items:[{sku:'PART',title:'Sample part',quantity:1,unitPriceCents:1000,hsCode:'392690',countryOfOrigin:'US',battery:'none',dangerousGoods:false}]}};
const parcel={name:'Saved carton',kg:2,length:30,width:20,height:10};

test('real-adapter requests use saved dimensions, compare same-currency totals, and disclose partial provider failure',async()=>{
  const service=createShipping({config:{mode:'live',easyshipToken:'test-key',freightcomToken:'test-key'},sleep:async()=>{},fetcher:async(url,options)=>{
    if(url.endsWith('/rates')){const body=JSON.parse(options.body);assert.equal(body.parcels[0].box.length,30);assert.equal(body.destination_address.country_alpha2,'CA');return response({rates:[{courier_service:{id:'service-one',name:'Sample Courier'},currency:'CAD',total_charge:15.25,max_delivery_time:3},{courier_service:{id:'other',name:'Other currency'},currency:'USD',total_charge:1}]});}
    if(url.endsWith('/rate'))return response({request_id:'rate-id'});
    return response({status:{done:true},rates:[{carrier_name:'Sample',service_name:'Ground',service_id:'service-two',total:{value:'1600',currency:'CAD'},transit_time_days:4}]});
  }});
  const rates=await service.quote(order,parcel,address);assert.equal(rates.rates.length,2);assert.equal(rates.rates[0].priceCents,1525);assert.equal(rates.rates[1].priceCents,1600);assert.equal(rates.complete,false);assert.match(rates.errors[0].message,/different currency/);
  const denied=createShipping({config:{mode:'live',easyshipToken:'test-key'},sleep:async()=>{},fetcher:async()=>new Response('{}',{status:403})});const failed=await denied.quote(order,parcel,address);assert.equal(failed.rates.length,0);assert.equal(failed.errors.length,2);
  await assert.rejects(service.quote({...order,body:{...order.body,shippingAddress:{...address,countryCodeV2:'US'}}},parcel,address),/customs/);
  await assert.rejects(service.quote({...order,body:{...order.body,items:[{...order.body.items[0],battery:undefined}]}},parcel,address),/battery and dangerous-goods/);
  await assert.rejects(service.quote({...order,body:{...order.body,items:[{...order.body.items[0],dangerousGoods:undefined}]}},parcel,address),/battery and dangerous-goods/);
});
test('Easyship does not buy a label when its prepared shipment exceeds the approved price',async()=>{
  let purchases=0,ref;
  const service=createShipping({config:{mode:'live',easyshipToken:'test-key'},sleep:async()=>{},fetcher:async(url)=>{
    if(url.endsWith('/label'))purchases++;
    return response({shipment:{easyship_shipment_id:'shipment-one',rates:[{courier_service:{id:'selected'},currency:'CAD',total_charge:20}]}});
  }});
  const rate={provider:'easyship',serviceId:'selected',priceCents:1500,currency:'CAD',context:{from:address,to:address,parcel,store:order.store,orderName:'#1001',currency:'CAD',items:[]}};
  await assert.rejects(service.book(rate,'operation-one',id=>ref=id),/exceeds approval/);assert.equal(ref,'shipment-one');assert.equal(purchases,0);
});

test('domestic categories can replace HS codes without inventing a manufacturing country or permitting missing safety declarations',async()=>{
  let calls=0;
  const service=createShipping({config:{mode:'live',easyshipToken:'mock-key'},fetcher:async(url,options)=>{calls++;const item=JSON.parse(options.body).parcels[0].items[0];assert.equal(item.category,'accessory_no_battery');assert.equal(item.hs_code,undefined);assert.equal(item.origin_country_alpha2,undefined);return response({rates:[{courier_service:{id:'sample',name:'Sample'},currency:'CAD',total_charge:10}]});}});
  const domestic={...order,body:{...order.body,items:[{...order.body.items[0],hsCode:'',countryOfOrigin:'',category:'accessory_no_battery'}]}};
  const quote=await service.quote(domestic,parcel,address);assert.equal(quote.rates.length,1);assert.equal(calls,1);
  await assert.rejects(service.quote({...domestic,body:{...domestic.body,items:[{...domestic.body.items[0],battery:undefined}]}},parcel,address),/declarations/);assert.equal(calls,1);
});
test('booking timeouts retain provider reference and cannot trigger duplicate purchase; reconciliation can finish tracking',async()=>{
  const db=openStore(':memory:'),user={id:addUser(db,'owner','shipping-test-password')};
  db.prepare('INSERT INTO ops_orders(store,external_id,body,updated_at) VALUES(?,?,?,?)').run(order.store,'external-order',JSON.stringify(order.body),'now');
  let writes=0;
  const shipping={status:()=>({mode:'live'}),book:async(rate,key,save)=>{writes++;save('provider-reference');const error=new Error('Outcome unknown');error.unknown=true;throw error;},retrieve:async()=>({externalId:'provider-reference',tracking:'TRACK-ONE',priceCents:1500,currency:'CAD',state:'in-transit'})};
  const jobs=createShippingJobs(db,shipping,{verifyOrder:async()=>{},fulfill:async()=>{}}),rate={provider:'easyship',service:'Sample service',priceCents:1500,currency:'CAD',simulated:false};
  try{
    const job=jobs.submit(order,rate,user);await jobs.run(job.id);assert.equal(db.prepare('SELECT status FROM ops_booking_jobs').get().status,'unknown');
    assert.equal(jobs.submit(order,rate,user).id,job.id);await jobs.run(job.id);assert.equal(writes,1);
    await jobs.run(job.id,{reconcile:true});assert.equal(db.prepare('SELECT status FROM ops_booking_jobs').get().status,'succeeded');assert.equal(db.prepare('SELECT tracking FROM ops_shipments').get().tracking,'TRACK-ONE');assert.equal(writes,1);
  }finally{jobs.stop();db.close();}
});
