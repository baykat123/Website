import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';

test('inbox browsing pages and literal searches retain history and protect private snapshots from staff',async()=>{
  const app=createApp({dbPath:':memory:',integrations:{config:{}},shipping:{config:{mode:'simulation'}},monitor:{intervalSeconds:0}});
  addUser(app.db,'owner','email-page-test-password');addUser(app.db,'staff','email-page-test-password');
  for(let i=0;i<105;i++)app.db.prepare("INSERT INTO external_records VALUES('gmail',?,'message',?,'now')").run(`sample-${String(i).padStart(3,'0')}`,JSON.stringify({title:`Fictional message ${i}`,contact:'sample@example.test',notes:'Fictional metadata'}));
  app.db.prepare("INSERT INTO external_records VALUES('gmail','wildcard','message',?,'now')").run(JSON.stringify({title:'Sample 50% estimate',contact:'sample@example.test'}));
  app.db.prepare("INSERT INTO external_records VALUES('shopify','sample-order','order',?,'now')").run(JSON.stringify({title:'#SAMPLE'}));
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const get=async path=>{const r=await fetch(base+path,{headers:{Cookie:cookie}});return {status:r.status,data:await r.json()};};
  const login=async username=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'email-page-test-password'})});cookie=r.headers.get('set-cookie').split(';')[0];};
  try{
    await login('owner');const ids=[];
    for(let offset=0;offset<106;offset+=25){const page=await get(`/api/integrations/records?provider=gmail&limit=25&offset=${offset}`);assert.equal(page.status,200);assert.ok(page.data.length<=25);ids.push(...page.data.map(x=>x.external_id));}
    assert.equal(ids.length,106);assert.equal(new Set(ids).size,106);assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM external_records WHERE provider='gmail'").get().n,106);
    assert.equal((await get('/api/integrations/records?provider=gmail&q=%25')).data.length,1,'percent searches are literal rather than unbounded SQL wildcards');
    assert.equal((await get('/api/integrations/records?provider=gmail&limit=101')).status,400);assert.equal((await get('/api/integrations/records?provider=gmail&offset=-1')).status,400);
    await login('staff');assert.equal((await get('/api/integrations/records?provider=gmail&limit=10')).status,403);const visible=await get('/api/integrations/records?limit=10');assert.equal(visible.data.length,1);assert.equal(visible.data[0].provider,'shopify');
    assert.equal((await get('/api/ops/email-suggestions?orderId=1')).status,403);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
