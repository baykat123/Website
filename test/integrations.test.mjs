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
      return response({data:{orders:{nodes:[{id:'gid://shopify/Order/1',name:'#1001',createdAt:'2026-10-04',displayFinancialStatus:'PAID',displayFulfillmentStatus:'UNFULFILLED',totalPriceSet:{shopMoney:{amount:'12.50',currencyCode:'USD'}}}]},products:{nodes:[{id:'gid://shopify/Product/1',title:'Test product',handle:'test',status:'ACTIVE',vendor:'Supplier'}]}}});
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
