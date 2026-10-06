import {test} from 'node:test';
import assert from 'node:assert/strict';
import {salesPdf} from '../lib/sales-pdf.mjs';
import {validateRecord} from '../lib/records.mjs';
import {createApp} from '../server.mjs';
import {addUser} from '../lib/store.mjs';

test('sales PDFs paginate long quotes and their downloads require a signed-in account',async()=>{
  const b=validateRecord('quote',{title:'Sample quote',contact:'Sample Customer',items:Array.from({length:100},(_,i)=>({description:`Sample item ${i+1}: `+'Long wrapping description '.repeat(6),quantity:2,unitPrice:'125.00'})),shipping:'10',tax:'20'});
  const buffer=await salesPdf({id:1,type:'quote',body:b,version:1,updated_at:'2026-10-06T00:00:00Z'});
  assert.equal(buffer.subarray(0,5).toString(),'%PDF-');assert.match(buffer.toString('latin1'),/\/Count [2-9]\d*/);
  const app=createApp({dbPath:':memory:'});addUser(app.db,'demo','test-pdf-password');await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    assert.equal((await fetch(base+'/api/records/1/pdf')).status,401);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo',password:'test-pdf-password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const record=await (await fetch(base+'/api/records',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'quote',title:'Sample',items:[{description:'Part',quantity:1,unitPrice:'10'}]})})).json();
    const pdf=await fetch(base+`/api/records/${record.id}/pdf`,{headers:{Cookie:cookie}});assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);assert.match(pdf.headers.get('content-disposition'),/quote-1.pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();}
});
