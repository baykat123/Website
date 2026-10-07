import { randomUUID } from 'node:crypto';
import { event, requireOwner, RequestError } from './team.mjs';
import { validateAddress } from './shipping.mjs';
const decode=row=>row&&{...row,body:JSON.parse(row.body)};

export function createShippingJobs(db,shipping,{verifyOrder,fulfill}={}) {
  // A crash after a write may have charged the provider. Recover via retrieval, never automatically rebook.
  db.prepare("UPDATE ops_booking_jobs SET status='unknown',error='Process restarted during booking; reconcile provider status' WHERE status='running'").run();
  const running=new Set();
  function status(){return {...shipping.status(),origins:db.prepare('SELECT * FROM shipping_origins ORDER BY store').all().map(decode),products:db.prepare('SELECT * FROM shipping_products ORDER BY store,sku').all().map(decode),jobs:db.prepare('SELECT * FROM ops_booking_jobs ORDER BY id DESC LIMIT 100').all().map(row=>({...row,body:undefined}))};}
  function commit(job,result) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rate=JSON.parse(job.body),at=new Date().toISOString();
      db.prepare("INSERT OR IGNORE INTO ops_shipments(order_id,provider,service,price_cents,currency,tracking,status,created_at,external_id,label_url,tracking_url,fulfillment_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')").run(job.order_id,rate.provider,rate.service,result.priceCents??rate.priceCents,result.currency??rate.currency,result.tracking,result.state==='simulated'?'simulated':'booked',at,result.externalId,result.labelUrl??'',result.trackingUrl??'');
      db.prepare("UPDATE ops_booking_jobs SET status='succeeded',external_id=?,error='',updated_at=? WHERE id=?").run(result.externalId,at,job.id);
      const already=db.prepare("SELECT id FROM ops_notes WHERE order_id=? AND kind='tracking' AND content=?").get(job.order_id,`${result.state==='simulated'?'SIMULATION: ':''}${rate.provider} tracking ${result.tracking}`);
      if(!already)db.prepare("INSERT INTO ops_notes(order_id,user_id,kind,content,created_at) VALUES(?,?,'tracking',?,?)").run(job.order_id,job.approved_by,`${result.state==='simulated'?'SIMULATION: ':''}${rate.provider} tracking ${result.tracking}`,at);
      if(!rate.simulated&&rate.environment!=='sandbox'&&!already){const order=db.prepare('SELECT body FROM ops_orders WHERE id=?').get(job.order_id),body=JSON.parse(order.body);
        if(body.contact){const data={title:`Tracking for ${body.title}`,status:'draft',contact:body.contact,notes:`Tracking is available for order ${body.title}.\nCarrier: ${rate.service}\nTracking number: ${result.tracking}\n${result.trackingUrl ?? ''}`,currency:body.currency};db.prepare("INSERT INTO records(type,body,created_by,updated_by,created_at,updated_at) VALUES('message',?,?,?,?,?)").run(JSON.stringify(data),job.approved_by,job.approved_by,at,at);}
      }
      event(db,{id:job.approved_by},`Shipment ${result.state==='simulated'?'simulated':'booked'} for order desk #${job.order_id}`);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  async function updateFulfillment(job,result) {
    const rate=JSON.parse(job.body);
    if(rate.simulated||rate.environment==='sandbox'){db.prepare("UPDATE ops_shipments SET fulfillment_status='simulated' WHERE order_id=?").run(job.order_id);return;}
    try{
      if(!fulfill)throw new RequestError(503,'Shopify tracking write integration is unavailable');
      const order=decode(db.prepare('SELECT * FROM ops_orders WHERE id=?').get(job.order_id));
      await fulfill(order,result);
      db.prepare("UPDATE ops_shipments SET fulfillment_status='synced' WHERE order_id=?").run(job.order_id);
      event(db,{id:job.approved_by},`Shopify fulfillment and tracking synced for order desk #${job.order_id}`);
    }catch(error){db.prepare("UPDATE ops_shipments SET fulfillment_status='needs_review' WHERE order_id=?").run(job.order_id);db.prepare('UPDATE ops_booking_jobs SET error=? WHERE id=?').run(`Shipment booked; Shopify tracking update requires review: ${error.message}`,job.id);}
  }
  async function run(id,{reconcile=false}={}) {
    if(running.has(id))return;running.add(id);
    const job=db.prepare('SELECT * FROM ops_booking_jobs WHERE id=?').get(id);
    try{
      if(!job)throw new RequestError(404,'Shipping job not found');
      const rate=JSON.parse(job.body);
      if(reconcile){if(!job.external_id)throw new RequestError(409,'No provider shipment reference is available. Verify the provider before any retry');const result=await shipping.retrieve(rate.provider,job.external_id);if(!result.tracking)throw new RequestError(409,'Provider has not returned tracking yet');commit(job,result);await updateFulfillment(job,result);return;}
      if(job.status!=='queued')throw new RequestError(409,'This shipping job is not queued');
      const order=decode(db.prepare('SELECT * FROM ops_orders WHERE id=?').get(job.order_id));
      if(JSON.stringify(order.body)!==job.order_snapshot)throw new RequestError(409,'Order changed after shipment approval');
      if(!rate.simulated&&rate.environment!=='sandbox'){if(!verifyOrder)throw new RequestError(503,'Live order verification is unavailable');await verifyOrder(order,rate.context?.from);}
      db.prepare("UPDATE ops_booking_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(),id);
      const result=await shipping.book(rate,job.operation_key,externalId=>db.prepare('UPDATE ops_booking_jobs SET external_id=? WHERE id=?').run(externalId,id));
      commit(job,result);await updateFulfillment(job,result);
    }catch(error){
      if(job){const reference=db.prepare('SELECT external_id FROM ops_booking_jobs WHERE id=?').get(id)?.external_id;db.prepare('UPDATE ops_booking_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(error.unknown||reference?'unknown':'failed',error.message,new Date().toISOString(),id);}
    }finally{running.delete(id);}
  }
  function submit(order,rate,user) {
    const existing=db.prepare('SELECT * FROM ops_booking_jobs WHERE order_id=?').get(order.id);
    if(existing){if(existing.status==='failed'&&!existing.external_id){db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO ops_booking_history(job_id,body,status,error,at) VALUES(?,?,?,?,?)').run(existing.id,existing.body,existing.status,existing.error,new Date().toISOString());db.prepare("UPDATE ops_booking_jobs SET body=?,order_snapshot=?,operation_key=?,status='queued',approved_by=?,error='',updated_at=? WHERE id=?").run(JSON.stringify(rate),JSON.stringify(order.body),randomUUID(),user.id,new Date().toISOString(),existing.id);event(db,user,`Approved a new shipment attempt after verified failure for order #${order.id}`);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}return db.prepare('SELECT * FROM ops_booking_jobs WHERE id=?').get(existing.id);}
    const id=Number(db.prepare("INSERT INTO ops_booking_jobs(order_id,body,order_snapshot,operation_key,status,approved_by,updated_at) VALUES(?,?,?,?,'queued',?,?)").run(order.id,JSON.stringify(rate),JSON.stringify(order.body),randomUUID(),user.id,new Date().toISOString()).lastInsertRowid);
    return db.prepare('SELECT * FROM ops_booking_jobs WHERE id=?').get(id);
  }
  async function handle({path,req,body,user,json}) {
    if(!path.startsWith('/api/shipping'))return false;
    requireOwner(user);
    if(req.method==='GET'&&path==='/api/shipping/settings'){json(200,status());return true;}
    if(req.method==='POST'&&path==='/api/shipping/origin'){
      if(typeof body.store!=='string'||!body.store.trim()||body.store.length>160)throw new RequestError(400,'Store identity is required');
      const origin=validateAddress(body.address);db.prepare('INSERT INTO shipping_origins(store,body) VALUES(?,?) ON CONFLICT(store) DO UPDATE SET body=excluded.body').run(body.store,JSON.stringify(origin));event(db,user,`Updated shipping origin for ${body.store}`);json(200,{ok:true});return true;
    }
    if(req.method==='POST'&&path==='/api/shipping/product'){
      if(typeof body.store!=='string'||!body.store.trim()||body.store.length>160||typeof body.sku!=='string'||!body.sku.trim()||body.sku.length>160||(!/^\d{6,10}$/.test(body.hsCode??'')&&!/^[a-z_]{1,80}$/.test(body.category??''))||body.hsCode&&!/^\d{6,10}$/.test(body.hsCode)||body.countryOfOrigin&&!/^[A-Z]{2}$/.test(body.countryOfOrigin)||!['none','in_equipment','packed_with_equipment'].includes(body.battery)||typeof body.dangerousGoods!=='boolean')throw new RequestError(400,'Store, SKU, category or verified HS code, and battery/dangerous-goods declarations are required');
      const data={hsCode:body.hsCode||undefined,category:body.category||undefined,countryOfOrigin:body.countryOfOrigin||undefined,battery:body.battery,dangerousGoods:body.dangerousGoods};db.prepare('INSERT INTO shipping_products(store,sku,body) VALUES(?,?,?) ON CONFLICT(store,sku) DO UPDATE SET body=excluded.body').run(body.store,body.sku,JSON.stringify(data));event(db,user,`Updated shipping classification for ${body.store} ${body.sku}`);json(200,{ok:true});return true;
    }
    const match=path.match(/^\/api\/shipping\/jobs\/(\d+)\/(reconcile|retry-tracking|cancel-unpaid)$/);
    if(req.method==='POST'&&match){const job=db.prepare('SELECT * FROM ops_booking_jobs WHERE id=?').get(Number(match[1]));if(!job)throw new RequestError(404,'Shipping job not found');
      if(match[2]==='cancel-unpaid'){if(body.confirm!==true||!job.external_id)throw new RequestError(400,'Confirm cancellation of the unpaid provider draft');const rate=JSON.parse(job.body);await shipping.cancelUnpaidDraft(rate.provider,job.external_id,job.operation_key);db.prepare('INSERT INTO ops_booking_history(job_id,body,status,error,at) VALUES(?,?,?,?,?)').run(job.id,job.body,job.status,job.error,new Date().toISOString());db.prepare("UPDATE ops_booking_jobs SET status='failed',external_id=NULL,error='Unpaid provider draft removed; fresh rate approval required' WHERE id=?").run(job.id);event(db,user,`Removed unpaid provider draft for job #${job.id}`);json(200,{ok:true});return true;}
      if(match[2]==='reconcile')await run(job.id,{reconcile:true});
      else {if(job.status!=='succeeded'||!job.external_id)throw new RequestError(409,'A booked shipment is required');const rate=JSON.parse(job.body),result=await shipping.retrieve(rate.provider,job.external_id);await updateFulfillment(job,result);}
      json(200,db.prepare('SELECT * FROM ops_booking_jobs WHERE id=?').get(job.id));return true;}
    return false;
  }
  let stopped=false;
  const timer=setInterval(()=>{if(stopped)return;for(const job of db.prepare("SELECT id FROM ops_booking_jobs WHERE status='queued'").all())run(job.id).catch(()=>{});},5000);timer.unref();
  const stop=()=>{stopped=true;clearInterval(timer);};
  return {status,submit,run,handle,stop};
}
