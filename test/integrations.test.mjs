import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { openStore, addUser, tokenHash } from '../lib/store.mjs';
import { createIntegrations, encrypt, decrypt } from '../lib/integrations.mjs';

const config={publicUrl:'https://operations.example.test',key:'only-test-encryption-key-'.repeat(3),gmailEmail:'owner@example.test',googleClientId:'test-google-client',googleClientSecret:'test-google-secret',shop:'example-test.myshopify.com',shopifyClientId:'test-shopify-client',shopifyClientSecret:'test-shopify-secret'};
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function setup(fetcher, overrides={}) {
  const db=openStore(':memory:');const id=addUser(db,'owner','test-password-is-long-enough');
  return {db,owner:{id,role:'owner'},service:createIntegrations(db,{config:{...config,...overrides},fetcher})};
}
function callbackParams(url, extra={}) { return new URLSearchParams({state:new URL(url).searchParams.get('state'),code:'test-authorization-code',...extra}); }

test('encrypted credentials reject tampering, wrong keys, and wrong provider context',()=>{
  const tokens={accessToken:'mock-confidential-token'}, sealed=encrypt(tokens,config.key,'gmail');
  assert.ok(!sealed.includes(tokens.accessToken)); assert.deepEqual(decrypt(sealed,config.key,'gmail'),tokens);
  assert.throws(()=>decrypt(sealed,config.key,'shopify')); assert.throws(()=>decrypt(sealed,'wrong-key'.repeat(8),'gmail'));
  const parts=sealed.split('.');parts[2]=Buffer.from('tampered').toString('base64url');assert.throws(()=>decrypt(parts.join('.'),config.key,'gmail'));
});

test('warehouse discovery requires granted location scope, paginates active locations, and is owner-only',async()=>{
  let calls=0;const {db,owner,service}=setup(async(url,options)=>{calls++;assert.equal(url,`https://${config.shop}/admin/api/2026-10/graphql.json`);const after=JSON.parse(options.body).variables.after;return response({data:{locations:{nodes:after?[{id:'gid://shopify/Location/2',name:'Inactive',isActive:false,fulfillsOnlineOrders:true,address:{}}]:[{id:'gid://shopify/Location/1',name:'Sample warehouse',isActive:true,fulfillsOnlineOrders:true,address:{address1:'Sample Street',city:'Toronto',countryCode:'CA',phone:'4165550100'}}],pageInfo:after?{hasNextPage:false}:{hasNextPage:true,endCursor:'next'}}}});},{allowFulfillment:true});
  const context={path:'/api/integrations/shopify/locations',req:{method:'GET'},user:owner,json:(status,data)=>{context.result={status,data};}};
  const save=scopes=>db.prepare("INSERT INTO connections(provider,account,encrypted_tokens,updated_at) VALUES('shopify',?,?,'now') ON CONFLICT(provider) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens").run(config.shop,encrypt({accessToken:'mock-token',scopes},config.key,'shopify'));
  try{
    save('read_orders,read_products');await assert.rejects(service.handle(context),/location-reading/);assert.equal(calls,0);assert.equal(service.status()[1].fulfillmentEnabled,false);
    save('read_orders,read_products,read_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders');
    assert.equal(service.status()[1].fulfillmentEnabled,true);assert.equal(service.status()[1].locationsEnabled,true);
    assert.equal(new URL(service.begin('shopify',owner,'mock-session')).searchParams.get('scope').includes('read_locations'),true);
    await assert.rejects(service.handle({...context,user:{...owner,role:'member'}}),/owner/);
    assert.equal(await service.handle(context),true);assert.equal(calls,2);assert.equal(context.result.status,200);assert.equal(context.result.data.length,1);assert.equal(context.result.data[0].address.countryCodeV2,'CA');assert.equal(context.result.data[0].store,config.shop);
  }finally{db.close();}
});

test('Shopify accepts write scopes that imply the requested read scopes without accepting a read-only fulfillment grant',async()=>{
  let writable=true;
  const {db,owner,service}=setup(async()=>response({access_token:'mock-authorization-token',scope:`read_orders,read_products,read_locations,${writable?'write':'read'}_merchant_managed_fulfillment_orders`}),{allowFulfillment:true});
  const session=tokenHash('mock-session');
  const params=()=>{const result=callbackParams(service.begin('shopify',owner,session),{shop:config.shop,timestamp:String(Math.floor(Date.now()/1000))});const sorted=new URLSearchParams([...result.entries()].sort(([a],[b])=>a.localeCompare(b)));result.set('hmac',createHmac('sha256',config.shopifyClientSecret).update(sorted.toString()).digest('hex'));return result;};
  try{await service.finish('shopify',params(),owner,session);assert.equal(service.status()[1].fulfillmentEnabled,true);assert.equal(service.status()[1].locationsEnabled,true);const original=db.prepare("SELECT encrypted_tokens FROM connections WHERE provider='shopify'").get().encrypted_tokens;
    writable=false;await assert.rejects(service.finish('shopify',params(),owner,session),/requested permissions/);assert.equal(db.prepare("SELECT encrypted_tokens FROM connections WHERE provider='shopify'").get().encrypted_tokens,original);
  }finally{db.close();}
});

test('permission verification migrates legacy token metadata only from actual provider grants and preserves credentials',async()=>{
  let writable=false,calls=0;
  const {db,owner,service}=setup(async(url,options)=>{calls++;assert.equal(options.headers['X-Shopify-Access-Token'],'mock-legacy-token');assert.ok(JSON.parse(options.body).query.includes('OperationsPermissions'));return response({data:{currentAppInstallation:{accessScopes:['read_orders','read_products','read_locations',`${writable?'write':'read'}_merchant_managed_fulfillment_orders`].map(handle=>({handle}))}}});},{allowFulfillment:true});
  db.prepare("INSERT INTO connections(provider,account,encrypted_tokens,updated_at,last_sync) VALUES('shopify',?,?, 'old','existing-sync')").run(config.shop,encrypt({accessToken:'mock-legacy-token',refreshToken:'mock-refresh-token',expiresAt:null},config.key,'shopify'));
  const context={path:'/api/integrations/shopify/permissions',req:{method:'POST'},user:owner,json:(status,data)=>{context.result={status,data};}};
  try{await assert.rejects(service.handle({...context,user:{...owner,role:'member'}}),/owner/);assert.equal(calls,0);await service.handle(context);assert.equal(context.result.data.fulfillmentEnabled,false);assert.equal(context.result.data.locationsEnabled,true);
    writable=true;await service.handle(context);assert.equal(context.result.data.fulfillmentEnabled,true);const stored=db.prepare("SELECT encrypted_tokens,last_sync FROM connections WHERE provider='shopify'").get();assert.equal(stored.last_sync,'existing-sync');const tokens=decrypt(stored.encrypted_tokens,config.key,'shopify');assert.equal(tokens.accessToken,'mock-legacy-token');assert.equal(tokens.refreshToken,'mock-refresh-token');assert.equal(tokens.scopes.includes('write_merchant_managed_fulfillment_orders'),true);
  }finally{db.close();}
});

test('Gmail OAuth binds state to owner and session, uses PKCE, refreshes encrypted tokens, and safely replaces inbox snapshots',async()=>{
  let authUrl,tokenRequests=0,wrongAccount=false,providerFails=false;
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,method:options.method??'GET'});
    if(url==='https://oauth2.googleapis.com/token') {
      const params=new URLSearchParams(options.body);tokenRequests++;
      if(params.get('grant_type')==='authorization_code') {
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),new URL(authUrl).searchParams.get('code_challenge'));
        assert.equal(params.get('redirect_uri'),'https://operations.example.test/api/integrations/gmail/callback');
        return response({access_token:'mock-initial-token',refresh_token:'mock-refresh-token',expires_in:0,scope:'https://www.googleapis.com/auth/gmail.readonly'});
      }
      assert.equal(params.get('refresh_token'),'mock-refresh-token');
      return response({access_token:'mock-refreshed-token',expires_in:3600});
    }
    if(url.endsWith('/profile'))return response({emailAddress:wrongAccount?'wrong@example.test':config.gmailEmail});
    if(url.includes('/messages?'))return providerFails?new Response('{}',{status:403}):response({messages:[{id:'message1'},{id:'message2'}]});
    if(url.includes('/messages/message'))return response({threadId:'thread1',snippet:'Preview <script>unsafe</script>',payload:{headers:[{name:'Subject',value:'Customer request'},{name:'From',value:'customer@example.test'}]}});
    throw new Error('Unexpected endpoint');
  };
  const {db,owner,service}=setup(fetcher),session=tokenHash('test-session');
  try {
    assert.equal(service.status()[0].connected,false);
    authUrl=service.begin('gmail',owner,session);
    const params=callbackParams(authUrl);
    assert.equal(new URL(authUrl).searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');
    await assert.rejects(service.finish('gmail',params,owner,tokenHash('other-session')),/session/);
    await assert.rejects(service.finish('gmail',params,{id:owner.id,role:'member'},session),/owner/);
    await service.finish('gmail',params,owner,session);
    await assert.rejects(service.finish('gmail',params,owner,session),/expired/);
    const row=db.prepare('SELECT * FROM connections').get();
    assert.ok(!row.encrypted_tokens.includes('mock-refresh-token'));
    assert.equal(service.status()[0].account,config.gmailEmail);
    assert.ok(!JSON.stringify(service.status()).includes('mock-initial-token'));
    assert.equal((await service.sync('gmail',owner)).count,2);
    assert.equal(tokenRequests,2);
    assert.equal((await service.sync('gmail',owner)).count,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM external_records').get().count,2);
    providerFails=true;
    await assert.rejects(service.sync('gmail',owner),/access was denied/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM external_records').get().count,2);
    wrongAccount=true;authUrl=service.begin('gmail',owner,session);
    await assert.rejects(service.finish('gmail',callbackParams(authUrl),owner,session),/business mailbox/);
    assert.equal(service.status()[0].account,config.gmailEmail);
    assert.ok(calls.every(call=>!call.url.includes('/send')&&!call.url.includes('/modify')));
  } finally{db.close();}
});

test('Shopify requires the expected store, SDK-validated HMAC and state, and imports orders/products without external writes',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,body:options.body});
    if(url.endsWith('/oauth/access_token'))return response({access_token:'mock-shopify-token',scope:'read_orders,read_products'});
    if(url.endsWith('/graphql.json')) {
      assert.ok(!JSON.parse(options.body).query.includes('mutation'));
      return response({data:{orders:{nodes:[{id:'gid://shopify/Order/1',name:'#1001',createdAt:'2026-10-04',displayFinancialStatus:'PAID',displayFulfillmentStatus:'UNFULFILLED',currentTotalPriceSet:{shopMoney:{amount:'12.50',currencyCode:'USD'}},currentShippingPriceSet:{shopMoney:{amount:'0',currencyCode:'USD'}},currentTotalTaxSet:{shopMoney:{amount:'0',currencyCode:'USD'}},lineItems:{nodes:[{id:'gid://shopify/LineItem/1',sku:'PART',title:'Part',currentQuantity:1,unfulfilledQuantity:1,requiresShipping:true,variant:{barcode:'12345'},originalUnitPriceSet:{shopMoney:{amount:'12.50',currencyCode:'USD'}},priceAfterAllDiscountsBeforeTaxesSet:{shopMoney:{amount:'12.50',currencyCode:'USD'}}}]} }]},products:{nodes:[{id:'gid://shopify/Product/1',title:'Test product',handle:'test',status:'ACTIVE',vendor:'Supplier'}]}}});
    }
    throw new Error('Unexpected endpoint');
  };
  const {db,owner,service}=setup(fetcher),session=tokenHash('test-session');
  try {
    const authUrl=service.begin('shopify',owner,session);
    assert.equal(new URL(authUrl).host,config.shop);
    assert.equal(new URL(authUrl).searchParams.get('scope'),'read_orders,read_products');
    const params=callbackParams(authUrl,{shop:config.shop,timestamp:String(Math.floor(Date.now()/1000))});
    params.set('hmac','0'.repeat(64));
    await assert.rejects(service.finish('shopify',params,owner,session),/signature/);
    params.delete('hmac');
    const sorted=new URLSearchParams([...params.entries()].sort(([a],[b])=>a.localeCompare(b)));
    params.set('hmac',createHmac('sha256',config.shopifyClientSecret).update(sorted.toString()).digest('hex'));
    await service.finish('shopify',params,owner,session);
    await assert.rejects(service.finish('shopify',params,owner,session),/expired/);
    assert.equal((await service.sync('shopify',owner)).count,2);
    assert.equal((await service.sync('shopify',owner)).count,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM external_records').get().count,2);
    assert.equal(db.prepare("SELECT json_extract(body,'$.amount') AS amount FROM external_records WHERE type='order'").get().amount,'12.50');
    const bad=callbackParams(service.begin('shopify',owner,session),{shop:'attacker.example',timestamp:String(Math.floor(Date.now()/1000)),hmac:'0'.repeat(64)});
    await assert.rejects(service.finish('shopify',bad,owner,session),/store/);
    assert.equal(calls.filter(call=>call.url.endsWith('/oauth/access_token')).length,1);
  } finally{db.close();}
});

test('unconfigured connections remain disabled and expired OAuth state is rejected',async()=>{
  const {db,owner,service}=setup(()=>{throw new Error('No requests should be made');},{googleClientSecret:undefined});
  try {assert.equal(service.status()[0].configured,false);assert.throws(()=>service.begin('gmail',owner,tokenHash('session')),/initial setup/);}
  finally{db.close();}
  const enabled=setup(()=>{throw new Error('No requests should be made');});
  try{const url=enabled.service.begin('gmail',enabled.owner,tokenHash('session'));enabled.db.exec('UPDATE oauth_states SET expires=0');await assert.rejects(enabled.service.finish('gmail',callbackParams(url),enabled.owner,tokenHash('session')),/expired/);}
  finally{enabled.db.close();}
});

test('Shopify fulfillment requires granted write scopes, unchanged orders, matching remaining quantities, and provider tracking',async()=>{
  let changed=false,mutations=0;
  const fetcher=async(url,options)=>{
    const payload=JSON.parse(options.body);
    if(payload.query.includes('OperationsOrderState'))return response({data:{order:{id:'gid://shopify/Order/1',updatedAt:changed?'changed':'original',cancelledAt:null,displayFulfillmentStatus:'UNFULFILLED'}}});
    if(payload.query.includes('OperationsFulfillmentOrders'))return response({data:{order:{fulfillmentOrders:{pageInfo:{hasNextPage:false},nodes:[{id:'gid://shopify/FulfillmentOrder/1',status:'OPEN',assignedLocation:{location:{id:'gid://shopify/Location/1'}},lineItems:{pageInfo:{hasNextPage:false},nodes:[{id:'gid://shopify/FulfillmentOrderLineItem/1',remainingQuantity:2,lineItem:{id:'gid://shopify/LineItem/1'}}]}}]}}}});
    if(payload.query.includes('mutation OperationsFulfillmentCreate')){mutations++;assert.equal(payload.variables.fulfillment.notifyCustomer,false);assert.equal(payload.variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems[0].quantity,2);return response({data:{fulfillmentCreate:{fulfillment:{id:'gid://shopify/Fulfillment/1'},userErrors:[]}}});}
    throw new Error('Unexpected query');
  };
  const {db,owner,service}=setup(fetcher,{allowFulfillment:true});
  const order={store:config.shop,external_id:'gid://shopify/Order/1',body:{providerUpdatedAt:'original',items:[{lineId:'gid://shopify/LineItem/1',quantity:2}]}};
  try{
    db.prepare("INSERT INTO connections(provider,account,encrypted_tokens,updated_at) VALUES('shopify',?,?,?)").run(config.shop,encrypt({accessToken:'test-token',scopes:'read_orders,read_products'},config.key,'shopify'),'now');
    await assert.rejects(service.verifyOrder(order),/permissions/);
    db.prepare("UPDATE connections SET encrypted_tokens=? WHERE provider='shopify'").run(encrypt({accessToken:'test-token',scopes:'read_orders,read_products,write_merchant_managed_fulfillment_orders'},config.key,'shopify'));
    changed=true;await assert.rejects(service.verifyOrder(order),/changed/);changed=false;
    await assert.rejects(service.fulfill(order,{tracking:'SIM-not-live'}),/Verified provider tracking/);
    const result=await service.fulfill(order,{tracking:'TRACK-ONE',trackingUrl:'https://tracking.example.test/one'});assert.equal(result.id,'gid://shopify/Fulfillment/1');assert.equal(mutations,1);
  }finally{db.close();}
});

test('USA Shopify OAuth uses separate state, encrypted token context, and store identity for colliding order IDs',async()=>{
  const usaShop='usa-example.myshopify.com',usaSecret='test-usa-secret';
  const fetcher=async(url,options)=>{
    if(url.endsWith('/oauth/access_token'))return response({access_token:'mock-usa-token',scope:'read_orders,read_products'});
    if(url.endsWith('/graphql.json'))return response({data:{orders:{nodes:[{id:'gid://shopify/Order/1',name:'#1001',createdAt:'2026-10-06',updatedAt:'now',displayFinancialStatus:'PAID',displayFulfillmentStatus:'UNFULFILLED',email:'sample@example.test',currentTotalPriceSet:{shopMoney:{amount:'10',currencyCode:'USD'}},currentTotalTaxSet:{shopMoney:{amount:'0',currencyCode:'USD'}},currentShippingPriceSet:{shopMoney:{amount:'0',currencyCode:'USD'}},lineItems:{nodes:[{id:'line-one',title:'Part',sku:'PART',currentQuantity:1,unfulfilledQuantity:1,requiresShipping:true,originalUnitPriceSet:{shopMoney:{amount:'10',currencyCode:'USD'}},priceAfterAllDiscountsBeforeTaxesSet:{shopMoney:{amount:'10',currencyCode:'USD'}}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}},products:{nodes:[]}}});
    throw new Error('Unexpected endpoint');
  };
  const {db,owner,service}=setup(fetcher,{usaShop,usaClientId:'test-usa-client',usaClientSecret:usaSecret}),session=tokenHash('session');
  try{
    const url=service.begin('shopify_usa',owner,session);assert.equal(new URL(url).hostname,usaShop);assert.match(new URL(url).searchParams.get('redirect_uri'),/shopify_usa\/callback$/);
    const params=callbackParams(url,{shop:usaShop,timestamp:String(Math.floor(Date.now()/1000))}),sorted=new URLSearchParams([...params.entries()].sort(([a],[b])=>a.localeCompare(b)));params.set('hmac',createHmac('sha256',usaSecret).update(sorted.toString()).digest('hex'));
    await service.finish('shopify_usa',params,owner,session);
    assert.equal(service.status().find(item=>item.provider==='shopify_usa').account,usaShop);
    const token=db.prepare("SELECT encrypted_tokens FROM connections WHERE provider='shopify_usa'").get();assert.equal(decrypt(token.encrypted_tokens,config.key,'shopify_usa').accessToken,'mock-usa-token');assert.throws(()=>decrypt(token.encrypted_tokens,config.key,'shopify'));
    assert.equal((await service.sync('shopify_usa',owner)).count,1);
    assert.equal(db.prepare('SELECT store FROM ops_orders').get().store,usaShop);
    assert.equal(db.prepare('SELECT provider FROM external_records').get().provider,'shopify_usa');
  }finally{db.close();}
});

test('Gmail approved sending uses a stable MIME message ID and treats a timeout as uncertain rather than retrying',async()=>{
  let sends=0,timeout=false;
  const {db,owner,service}=setup(async(url,options)=>{
    if(url.endsWith('/messages/send')){sends++;const raw=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();assert.match(raw,/To: recipient@example.test/);assert.match(raw,/Message-ID: <ops-operation-one@operations.example.test>/);assert.match(raw,/Content-Transfer-Encoding: base64/);if(timeout)throw new Error('Timeout');return response({id:'message-sent'});}
    throw new Error('Unexpected request');
  },{allowGmailSend:true});
  try{
    db.prepare("INSERT INTO connections(provider,account,encrypted_tokens,updated_at) VALUES('gmail',?,?,?)").run(config.gmailEmail,encrypt({accessToken:'test-token',scopes:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'},config.key,'gmail'),'now');
    const payload={to:'recipient@example.test',subject:'Sample approved reply',content:'A test message.'};assert.equal((await service.sendGmail(payload,'operation-one')).id,'message-sent');
    timeout=true;await assert.rejects(service.sendGmail(payload,'operation-one'),error=>error.unknown===true);assert.equal(sends,2);
  }finally{db.close();}
});
