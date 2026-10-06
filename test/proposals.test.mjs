import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { addUser } from '../lib/store.mjs';

test('proposal review captures corrections, revokes approval after edits, and simulates once without provider calls', async () => {
  let providerCalls = 0;
  const app = createApp({dbPath:':memory:', integrations:{config:{},fetcher:async()=>{providerCalls++;throw new Error('Unexpected provider call');}}});
  addUser(app.db,'owner','test-proposal-password'); addUser(app.db,'member','test-proposal-password');
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie='';
  const request = async (path, body) => {
    const response = await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    assert.equal((await request('/api/proposals')).status,401);
    cookie=(await request('/api/login',{username:'member',password:'test-proposal-password'})).cookie;
    assert.equal((await request('/api/proposals')).status,403);
    cookie=(await request('/api/login',{username:'owner',password:'test-proposal-password'})).cookie;
    const record=(await request('/api/records',{type:'message',title:'Sample quote',contact:'sample@example.com',notes:'Original draft'})).data;
    const proposal=(await request('/api/proposals',{recordId:record.id})).data;
    assert.equal(proposal.status,'pending');
    assert.equal((await request('/api/proposals',{recordId:record.id})).status,409);
    assert.equal((await request(`/api/proposals/${proposal.id}/simulate`,{version:1})).status,409);
    const payload={to:'sample@example.com',subject:'Revised subject',content:'Revised draft'};
    assert.equal((await request(`/api/proposals/${proposal.id}/edit`,{version:1,payload})).status,200);
    assert.equal((await request(`/api/proposals/${proposal.id}/approve`,{version:1})).status,409);
    assert.equal((await request(`/api/proposals/${proposal.id}/approve`,{version:2,note:'Use concise language'})).status,200);
    const learning=(await request('/api/proposals/learning')).data;
    assert.equal(learning.automatic,false);
    assert.equal(learning.examples[0].before.content,'Original draft');
    assert.equal(learning.examples[0].after.content,'Revised draft');
    assert.equal(learning.examples[0].note,'Use concise language');
    const edited=(await request(`/api/proposals/${proposal.id}/edit`,{version:3,payload:{...payload,content:'Final draft'}})).data;
    assert.equal(edited.status,'pending');
    assert.equal((await request(`/api/proposals/${proposal.id}/simulate`,{version:4})).status,409);
    await request(`/api/proposals/${proposal.id}/approve`,{version:4});
    const simulated=(await request(`/api/proposals/${proposal.id}/simulate`,{version:5})).data;
    assert.equal(simulated.status,'simulated');
    assert.equal((await request(`/api/proposals/${proposal.id}/simulate`,{version:6})).data.version,6);
    assert.equal((await request(`/api/proposals/${proposal.id}/edit`,{version:6,payload})).status,409);
    const another=(await request('/api/records',{type:'message',title:'Sample quote',contact:'another@example.com',notes:'Original draft'})).data;
    const learned=(await request('/api/proposals',{recordId:another.id})).data;
    assert.equal(learned.body.to,'another@example.com');
    assert.equal(learned.body.subject,'Revised subject');
    assert.equal(learned.body.content,'Final draft');
    assert.equal(learned.original.content,'Original draft');
    assert.equal(learned.status,'pending');
    const product=(await request('/api/records',{type:'product',title:'Sample product',notes:'Product description'})).data;
    const productProposal=(await request('/api/proposals',{recordId:product.id})).data;
    assert.equal(productProposal.kind,'shopify_publish');
    await request(`/api/proposals/${productProposal.id}/reject`,{version:1,note:'Need more details'});
    assert.equal((await request(`/api/proposals/${productProposal.id}/approve`,{version:2})).status,409);
    assert.equal(providerCalls,0);
    assert.equal((await request('/api/proposals')).data.execution,'simulation_only');
  } finally {await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});

test('an executing email proposal cannot be edited or sent twice and its approved contents stay immutable',async()=>{
  const {encrypt}=await import('../lib/integrations.mjs');let completeSend,sends=0;
  const key='test-only-email-key-'.repeat(3),config={publicUrl:'https://ops.example.test',key,gmailEmail:'owner@example.test',googleClientId:'test-client',googleClientSecret:'test-secret',allowGmailSend:true};
  const app=createApp({dbPath:':memory:',integrations:{config,fetcher:async()=>{sends++;await new Promise(resolve=>completeSend=resolve);return new Response(JSON.stringify({id:'sent-one'}),{headers:{'Content-Type':'application/json'}});}}});addUser(app.db,'owner','send-test-password');
  app.db.prepare("INSERT INTO connections(provider,account,encrypted_tokens,updated_at) VALUES('gmail',?,?,?)").run(config.gmailEmail,encrypt({accessToken:'test-token',scopes:'https://www.googleapis.com/auth/gmail.send'},key,'gmail'),'now');
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const call=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
  try{
    cookie=(await call('/api/login',{username:'owner',password:'send-test-password'})).cookie;
    const record=(await call('/api/records',{type:'message',title:'Approved subject',contact:'recipient@example.test',notes:'Approved contents'})).data;
    const proposal=(await call('/api/proposals',{recordId:record.id})).data;
    await call(`/api/proposals/${proposal.id}/approve`,{version:1});
    const sending=call(`/api/proposals/${proposal.id}/execute`,{version:2});
    while(!completeSend)await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal((await call(`/api/proposals/${proposal.id}/edit`,{version:3,payload:{to:'different@example.test',subject:'Changed',content:'Changed'}})).status,409);
    assert.equal((await call(`/api/proposals/${proposal.id}/execute`,{version:3})).status,409);
    completeSend();assert.equal((await sending).data.status,'sent');assert.equal(sends,1);
    const row=app.db.prepare('SELECT body,version FROM proposals WHERE id=?').get(proposal.id);assert.equal(JSON.parse(row.body).content,'Approved contents');
    assert.equal((await call(`/api/proposals/${proposal.id}/edit`,{version:row.version,payload:{to:'different@example.test',subject:'Changed',content:'Changed'}})).status,409);
  }finally{if(completeSend)completeSend();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
