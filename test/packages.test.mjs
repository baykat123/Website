import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';
import {resolvePackage} from '../lib/packages.mjs';

test('saved packages convert units, retain quote snapshots, reject stale edits, and support archive/restore',async()=>{
  const app=createApp({dbPath:':memory:'});addUser(app.db,'owner','package-test-password');addUser(app.db,'staff','package-test-password');await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const call=async(path,body)=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
  const input={name:'Printer carton',length:20,width:18,height:24,weight:10,dimensionUnit:'in',weightUnit:'lb'};
  try{
    assert.equal((await call('/api/packages')).status,401);cookie=(await call('/api/login',{username:'staff',password:'package-test-password'})).cookie;
    assert.equal((await call('/api/packages',input)).status,403);cookie=(await call('/api/login',{username:'owner',password:'package-test-password'})).cookie;
    assert.equal((await call('/api/packages',{...input,weight:-1})).status,400);
    const pkg=(await call('/api/packages',input)).data;assert.equal(pkg.body.cm.length,50.8);assert.equal(pkg.body.kg,4.535923700000001);
    const snapshot=resolvePackage(app.db,{savedPackageId:pkg.id});assert.equal(snapshot.name,'Printer carton');assert.equal(snapshot.version,1);
    assert.equal((await call('/api/packages',{...input,name:'printer CARTON'})).status,409);
    assert.equal((await call(`/api/packages/${pkg.id}`,{version:1,payload:{...input,weight:20}})).status,200);
    assert.equal(snapshot.kg,4.535923700000001);assert.equal((await call(`/api/packages/${pkg.id}`,{version:1,archived:true})).status,409);
    await call(`/api/packages/${pkg.id}`,{version:2,archived:true});assert.throws(()=>resolvePackage(app.db,{savedPackageId:pkg.id}),/no longer available/);
    assert.equal((await call(`/api/packages/${pkg.id}`,{version:3,archived:false})).status,200);
    assert.equal((await call('/api/packages')).data[0].archived,false);
    assert.equal(resolvePackage(app.db,{savedPackageId:pkg.id,kg:7}).kg,7);
    const dimensionsOnly=(await call('/api/packages',{...input,name:'Dimensions only carton',weight:''})).data;assert.equal(dimensionsOnly.body.kg,null);
    assert.throws(()=>resolvePackage(app.db,{savedPackageId:dimensionsOnly.id}),/valid weight/);
    assert.equal(resolvePackage(app.db,{savedPackageId:dimensionsOnly.id,kg:3}).kg,3);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
