import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { addUser } from '../lib/store.mjs';

test('owner invitations are single-use, expire, and create unprivileged shared accounts; password changes revoke sessions', async () => {
  const app = createApp({dbPath:':memory:'});
  const password='strong-test-password-only'; addUser(app.db,'owner',password);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(path,body,cookie='')=>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    assert.equal((await request('/api/team')).status,401);
    const login=await request('/api/login',{username:'owner',password}); assert.equal(login.body.role,'owner');
    const owner=login.cookie;
    const invitation=await request('/api/team/invite',{email:'member@example.test'},owner);
    assert.equal(invitation.status,201);
    const token=new URL(invitation.body.path,base).searchParams.get('token');
    assert.ok(!app.db.prepare('SELECT token FROM invites').get().token.includes(token));
    const values={token,username:'teammate',password};
    assert.equal((await request('/api/invites/accept',values)).status,201);
    assert.equal((await request('/api/invites/accept',values)).status,400);
    const memberLogin=await request('/api/login',{username:'teammate',password}), member=memberLogin.cookie;
    assert.equal(memberLogin.body.role,'member'); assert.equal(memberLogin.body.email,'member@example.test');
    assert.equal((await request('/api/team',undefined,member)).status,403);
    assert.equal((await request('/api/team/invite',{email:'other@example.test'},member)).status,403);
    assert.equal((await request('/api/integrations/gmail/connect',{},member)).status,403);
    assert.equal((await request('/api/records',{type:'task',title:'Shared team task'},owner)).status,201);
    assert.equal((await request('/api/records',undefined,member)).body.length,1);
    const old=await request('/api/team/invite',{email:'other@example.test'},owner);
    await request('/api/team/invite',{email:'other@example.test'},owner);
    assert.equal((await request('/api/invites/accept',{token:new URL(old.body.path,base).searchParams.get('token'),username:'other',password})).status,400);
    const expiry=await request('/api/team/invite',{email:'expired@example.test'},owner);
    app.db.prepare('UPDATE invites SET expires=0 WHERE email=?').run('expired@example.test');
    assert.equal((await request('/api/invites/accept',{token:new URL(expiry.body.path,base).searchParams.get('token'),username:'expired',password})).status,400);
    const second=(await request('/api/login',{username:'teammate',password})).cookie;
    assert.equal((await request('/api/password',{currentPassword:'wrong',newPassword:'replacement-test-password'},member)).status,400);
    assert.equal((await request('/api/password',{currentPassword:password,newPassword:'short'},member)).status,400);
    assert.equal((await request('/api/password',{currentPassword:password,newPassword:'replacement-test-password'},member)).status,200);
    assert.equal((await request('/api/me',undefined,member)).status,401);
    assert.equal((await request('/api/me',undefined,second)).status,401);
    assert.equal((await request('/api/login',{username:'teammate',password})).status,401);
    assert.equal((await request('/api/login',{username:'teammate',password:'replacement-test-password'})).status,200);
  } finally {await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
