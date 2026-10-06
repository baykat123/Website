import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore,addUser} from '../lib/store.mjs';
import {emailSuggestions,autoLinkEmails} from '../lib/email-linking.mjs';

test('email matching requires exact reference and customer identity, rejects ambiguous stores, and preserves rejected matches',()=>{
  const db=openStore(':memory:'),user={id:addUser(db,'owner','matching-test-password')};
  const putOrder=(store,title)=>Number(db.prepare('INSERT INTO ops_orders(store,external_id,body,updated_at) VALUES(?,?,?,?)').run(store,title,JSON.stringify({title,contact:'customer@example.test'}),'now').lastInsertRowid);
  const putEmail=(id,title,contact='customer@example.test')=>db.prepare("INSERT INTO external_records VALUES('gmail',?,'message',?,'now')").run(id,JSON.stringify({title,contact,notes:'Sample request'}));
  try{
    const first=putOrder('one.myshopify.com','#1001');putOrder('one.myshopify.com','#100');
    putEmail('exact','Question about #1001');assert.equal(emailSuggestions(db).length,1);assert.equal(autoLinkEmails(db,user),1);assert.equal(autoLinkEmails(db,user),0);
    putEmail('other-person','Question about #100','other@example.test');assert.equal(emailSuggestions(db)[0].autoLink,false);
    const second=putOrder('two.myshopify.com','#100');putEmail('ambiguous','Question about #100');assert.equal(emailSuggestions(db).filter(item=>item.emailId==='ambiguous').every(item=>!item.autoLink),true);
    db.prepare("INSERT INTO ops_email_decisions VALUES(?,?,'rejected',?,'now')").run(second,'ambiguous',user.id);assert.equal(emailSuggestions(db).filter(item=>item.emailId==='ambiguous').length,1);
    db.prepare("DELETE FROM external_records WHERE external_id='exact'").run();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_notes WHERE order_id=?').get(first).n,1);
  }finally{db.close();}
});
