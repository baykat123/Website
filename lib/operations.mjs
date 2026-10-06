import { collectSupportIntakes } from './support.mjs';
import { autoLinkEmails,emailSuggestions,linkEmail } from './email-linking.mjs';
import { resolvePackage } from './packages.mjs';
import { validateRecord, cents } from './records.mjs';
import { randomUUID } from 'node:crypto';
import { RequestError, event } from './team.mjs';

const parse = row => row && ({...row,body:JSON.parse(row.body)});
const string = (value, max=2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RequestError(400,'Required text is missing or too long');
  return value.trim();
};
function order(db,id) {
  const row = parse(db.prepare('SELECT * FROM ops_orders WHERE id=?').get(id));
  if (!row) throw new RequestError(404,'Order not found');
  return row;
}
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const result=fn();db.exec('COMMIT');return result;} catch(error) {db.exec('ROLLBACK');throw error;}
}
function prepareInvoice(db,row,user) {
  const b=row.body;
  if (db.prepare('SELECT record_id FROM ops_invoices WHERE order_id=?').get(row.id) || b.financialStatus!=='PAID') return;
  const invoiceItems=b.invoiceItems ?? b.items;
  if (!(invoiceItems ?? []).length || !invoiceItems.every(item=>Number.isSafeInteger(item.unitPriceCents) && item.unitPriceCents>=0) || !Number.isSafeInteger(b.shippingCents) || !Number.isSafeInteger(b.taxCents)) return;
  let data;
  try {
    data=validateRecord('invoice',{title:`Invoice draft for ${b.title}`,contact:b.contact ?? '',currency:b.currency,items:invoiceItems.map(item=>Number.isSafeInteger(item.lineTotalCents) ? {description:`${item.title || item.sku} (${item.quantity} units)`,quantity:1,unitPrice:(item.lineTotalCents/100).toFixed(2)} : {description:item.title || item.sku,quantity:item.quantity,unitPrice:(item.unitPriceCents/100).toFixed(2)}),shipping:(b.shippingCents/100).toFixed(2),tax:(b.taxCents/100).toFixed(2),notes:`Prepared from Shopify ${row.store} ${row.external_id}. Review before issuing.`});
    if (data.totalCents!==cents(b.amount)) return;
  } catch {return;}
  const now=new Date().toISOString();
  const id=Number(db.prepare("INSERT INTO records(type,body,created_by,updated_by,created_at,updated_at) VALUES('invoice',?,?,?,?,?)").run(JSON.stringify(data),user.id,user.id,now,now).lastInsertRowid);
  db.prepare('INSERT INTO ops_invoices(order_id,record_id,order_snapshot) VALUES(?,?,?)').run(row.id,id,JSON.stringify(row.body));
  db.prepare('INSERT INTO audit(user_id,record_id,action,at) VALUES(?,?,?,?)').run(user.id,id,`Automatically prepared invoice draft from order desk #${row.id}`,now);
}
function view(db,row) {
  const notes=db.prepare('SELECT ops_notes.*,users.username FROM ops_notes JOIN users ON users.id=ops_notes.user_id WHERE order_id=? ORDER BY ops_notes.id').all(row.id);
  const scans=db.prepare('SELECT sku,COUNT(*) AS scanned FROM ops_scans WHERE order_id=? AND active=1 GROUP BY sku').all(row.id);
  const raw=row.body.items ?? [], expected=[];
  const valid=raw.length>0 && raw.every(item=>typeof item.sku==='string' && item.sku && Number.isInteger(item.quantity) && item.quantity>0);
  if (valid) for(const item of raw){const existing=expected.find(row=>row.sku===item.sku);if(existing)existing.quantity+=item.quantity;else expected.push({...item});}
  const packed=valid && expected.every(item=>scans.find(scan=>scan.sku===item.sku)?.scanned===item.quantity);
  const invoice=db.prepare('SELECT * FROM ops_invoices WHERE order_id=?').get(row.id);
  return {...row,notes,scans,expectedItems:expected,packed,invoice:invoice && {recordId:invoice.record_id,needsReview:invoice.order_snapshot!==JSON.stringify(row.body)},shipments:db.prepare('SELECT * FROM ops_shipments WHERE order_id=? ORDER BY id DESC').all(row.id),tickets:db.prepare('SELECT * FROM ops_tickets WHERE order_id=? ORDER BY id DESC').all(row.id)};
}
export async function handleOperations({db,path,req,body,user,json,shipping,shippingJobs}) {
  if (!path.startsWith('/api/ops')) return false;
  if (!user) throw new RequestError(401,'Sign in required');
  const now=()=>new Date().toISOString();
  if (req.method==='GET' && path==='/api/ops/orders') {
    json(200,{execution:shipping.status().mode,orders:db.prepare('SELECT * FROM ops_orders ORDER BY id DESC').all().map(row=>view(db,parse(row)))});return true;
  }
  if(req.method==='GET'&&path==='/api/ops/email-suggestions'){if(user.role!=='owner')throw new RequestError(403,'Only the owner reviews private inbox links');json(200,emailSuggestions(db));return true;}
  if (req.method==='POST' && path==='/api/ops/import') {json(200,syncOrderDesk(db,user));return true;}
  if (req.method==='GET' && path==='/api/ops/tickets') {json(200,db.prepare('SELECT * FROM ops_tickets ORDER BY id DESC').all());return true;}
  const ticketMatch=path.match(/^\/api\/ops\/tickets\/(\d+)$/);
  if (req.method==='POST' && ticketMatch) {
    const ticket=db.prepare('SELECT * FROM ops_tickets WHERE id=?').get(Number(ticketMatch[1]));
    if (!ticket) throw new RequestError(404,'Ticket not found');
    if (body.version!==ticket.version) throw new RequestError(409,'Ticket changed. Refresh before saving.');
    if (!['open','in_progress','waiting_customer','waiting_supplier','resolved'].includes(body.status)) throw new RequestError(400,'Invalid ticket status');
    const assignee=body.assignee ?? '';
    if (typeof assignee!=='string' || assignee.length>80 || assignee && !db.prepare('SELECT id FROM users WHERE username=?').get(assignee)) throw new RequestError(400,'Assign the ticket to an existing teammate');
    const note=string(body.note);
    inTransaction(db,()=> {
      db.prepare('UPDATE ops_tickets SET status=?,assignee=?,version=version+1,updated_at=? WHERE id=?').run(body.status,assignee,now(),ticket.id);
      db.prepare("INSERT INTO ops_notes(order_id,user_id,kind,content,created_at) VALUES(?,?,'ticket',?,?)").run(ticket.order_id,user.id,`Ticket #${ticket.id}: ${body.status}. ${note}`,now());
      event(db,user,`Updated support ticket #${ticket.id}: ${body.status}`);
    });json(200,db.prepare('SELECT * FROM ops_tickets WHERE id=?').get(ticket.id));return true;
  }
  const match=path.match(/^\/api\/ops\/orders\/(\d+)\/(note|email|ticket|scan|rates|book)$/);
  if (req.method!=='POST' || !match) return false;
  const row=order(db,Number(match[1])), action=match[2];
  if (action==='note') {
    const content=string(body.content,10000);
    inTransaction(db,()=>{db.prepare("INSERT INTO ops_notes(order_id,user_id,kind,content,created_at) VALUES(?,?,'note',?,?)").run(row.id,user.id,content,now());event(db,user,`Added note to order desk #${row.id}`);});
    json(201,{ok:true});return true;
  }
  if (action==='email') {
    if(user.role!=='owner')throw new RequestError(403,'Only the owner can share an inbox email with order notes');
    const id=string(body.emailId,100);
    const email=db.prepare("SELECT * FROM external_records WHERE provider='gmail' AND type='message' AND external_id=?").get(id);
    if (!email) throw new RequestError(404,'Imported email not found');
    inTransaction(db,()=> {
      if(body.reject===true){db.prepare("INSERT INTO ops_email_decisions(order_id,email_id,decision,user_id,at) VALUES(?,?,'rejected',?,?) ON CONFLICT(order_id,email_id) DO UPDATE SET decision='rejected',user_id=excluded.user_id,at=excluded.at").run(row.id,id,user.id,now());event(db,user,`Rejected email link for order desk #${row.id}`);}
      else linkEmail(db,user,row.id,id,JSON.parse(email.body));
    });json(201,{ok:true});return true;
  }
  if (action==='ticket') {
    const title=string(body.title,160), details=string(body.details,10000), category=body.category;
    if (!['warranty','support','return','shipping'].includes(category)) throw new RequestError(400,'Invalid ticket category');
    const id=inTransaction(db,()=> {
      const id=Number(db.prepare("INSERT INTO ops_tickets(order_id,title,details,category,status,created_by,created_at,updated_at) VALUES(?,?,?,?, 'open',?,?,?)").run(row.id,title,details,category,user.id,now(),now()).lastInsertRowid);
      db.prepare("INSERT INTO ops_notes(order_id,user_id,kind,content,created_at) VALUES(?,?,'ticket',?,?)").run(row.id,user.id,`Opened ${category} ticket #${id}: ${title}`,now());
      event(db,user,`Opened ${category} ticket #${id} for order desk #${row.id}`);return id;
    });json(201,db.prepare('SELECT * FROM ops_tickets WHERE id=?').get(id));return true;
  }
  if (action==='scan') {
    const sku=string(body.sku,160), token=string(body.scanId,100);
    if (!(row.body.items ?? []).length) throw new RequestError(409,'Order line items are missing. Sync complete Shopify order data before scanning.');
    if (db.prepare('SELECT id FROM ops_shipments WHERE order_id=?').get(row.id)) throw new RequestError(409,'Packing is locked after shipment booking');
    const candidates=row.body.items.filter(item=>item.sku===sku || item.barcode===sku);
    if (new Set(candidates.map(item=>item.sku)).size>1) throw new RequestError(409,'Barcode is ambiguous across multiple SKUs; resolve the product mapping');
    const item=candidates[0];
    if (!item || !item.sku || !Number.isInteger(item.quantity) || item.quantity<1) throw new RequestError(400,'Scanned item is not expected on this order');
    const duplicate=db.prepare('SELECT * FROM ops_scans WHERE scan_key=?').get(token);
    if (duplicate) {
      if(!duplicate.active)throw new RequestError(409,'Order changed; verify the item with a fresh scan');
      if (duplicate.order_id!==row.id || duplicate.sku!==item.sku) throw new RequestError(409,'Scan key belongs to another item or order');
      json(200,{duplicate:true});return true;
    }
    const expected=view(db,row).expectedItems.find(line=>line.sku===item.sku)?.quantity;
    if (!expected) throw new RequestError(409,'Incomplete SKU quantities prevent packing');
    const scanned=db.prepare('SELECT COUNT(*) AS count FROM ops_scans WHERE order_id=? AND sku=? AND active=1').get(row.id,item.sku).count;
    if (scanned>=expected) throw new RequestError(409,'All units of this item have already been scanned');
    db.prepare('INSERT INTO ops_scans(order_id,sku,scan_key,user_id,at) VALUES(?,?,?,?,?)').run(row.id,item.sku,token,user.id,now());
    json(201,{sku:item.sku,scanned:scanned+1,expected});return true;
  }
  if (action==='rates') {
    const parcel=resolvePackage(db,body),origin=db.prepare('SELECT body FROM shipping_origins WHERE store=?').get(row.store);
    const enriched={...row,body:{...row.body,items:(row.body.items??[]).map(item=>{const profile=db.prepare('SELECT body FROM shipping_products WHERE store=? AND sku=?').get(row.store,item.sku);return {...item,...(profile?JSON.parse(profile.body):{})};})}};
    const result=await shipping.quote(enriched,parcel,origin?JSON.parse(origin.body):null),quoteKey=randomUUID(),expires=Date.now()+15*60000;
    for(const rate of result.rates){rate.productSnapshot=JSON.stringify(enriched.body.items);rate.originSnapshot=origin?.body??null;}
    for(const rate of result.rates)db.prepare('INSERT INTO ops_rates(id,order_id,body,expires,quote_key,order_snapshot) VALUES(?,?,?,?,?,?)').run(rate.id,row.id,JSON.stringify(rate),expires,quoteKey,JSON.stringify(row.body));
    json(200,{simulated:shipping.status().mode!=='live',expires,...result});return true;
  }
  if (action==='book') {
    if (row.body.cancelledAt || ['REFUNDED','VOIDED'].includes(row.body.financialStatus) || row.body.fulfillmentStatus==='FULFILLED') throw new RequestError(409,'This order is cancelled, refunded, voided, or already fulfilled');
    if (user.role!=='owner') throw new RequestError(403,'Only the owner can approve shipment booking');
    if (body.approve!==true) throw new RequestError(400,'Explicit approval required for the selected rate');
    const existing=db.prepare('SELECT * FROM ops_shipments WHERE order_id=?').get(row.id);
    if (existing) {json(200,existing);return true;}
    if (!view(db,row).packed) throw new RequestError(409,'Scan every required item before booking');
    const quote=db.prepare('SELECT * FROM ops_rates WHERE id=? AND order_id=? AND expires>?').get(body.rateId,row.id,Date.now());
    if (!quote || quote.order_snapshot!==JSON.stringify(row.body)) throw new RequestError(409,'Rate expired or order changed. Request fresh rates.');
    const rate=JSON.parse(quote.body);
    if(rate.package?.id){const pkg=db.prepare('SELECT version,archived FROM saved_packages WHERE id=?').get(rate.package.id);if(!pkg||pkg.archived||pkg.version!==rate.package.version)throw new RequestError(409,'Saved package changed. Compare shipping rates again');}
    const currentOrigin=db.prepare('SELECT body FROM shipping_origins WHERE store=?').get(row.store)?.body??null;if(rate.originSnapshot!==currentOrigin)throw new RequestError(409,'Shipping origin changed. Request fresh rates');
    const currentItems=(row.body.items??[]).map(item=>{const profile=db.prepare('SELECT body FROM shipping_products WHERE store=? AND sku=?').get(row.store,item.sku);return {...item,...(profile?JSON.parse(profile.body):{})};});if(rate.productSnapshot!==JSON.stringify(currentItems))throw new RequestError(409,'Product shipping declarations changed. Request fresh rates');
    const job=shippingJobs.submit(row,rate,user);
    await shippingJobs.run(job.id);
    const shipment=db.prepare('SELECT * FROM ops_shipments WHERE order_id=?').get(row.id);
    if(shipment){json(201,shipment);return true;}
    const result=db.prepare('SELECT status,error FROM ops_booking_jobs WHERE id=?').get(job.id);
    throw new RequestError(409,`Booking ${result.status}: ${result.error}`);
  }
  return false;
}

export function syncOrderDesk(db,user) {
  return inTransaction(db,()=> {
    const defaultStore=db.prepare("SELECT account FROM connections WHERE provider='shopify'").get()?.account ?? 'sample-store';
    const imported=db.prepare("SELECT * FROM external_records WHERE provider IN ('shopify','shopify_usa') AND type='order'").all();
    for(const record of imported){const snapshot=JSON.parse(record.body),store=snapshot.store ?? defaultStore,current=db.prepare('SELECT * FROM ops_orders WHERE store=? AND external_id=?').get(store,record.external_id);
      if(current){const previous=JSON.parse(current.body);if(packFingerprint(previous.items)!==packFingerprint(snapshot.items)&&!db.prepare('SELECT id FROM ops_shipments WHERE order_id=?').get(current.id))db.prepare('UPDATE ops_scans SET active=0 WHERE order_id=?').run(current.id);db.prepare('UPDATE ops_orders SET body=?,updated_at=? WHERE id=?').run(record.body,new Date().toISOString(),current.id);}
      else db.prepare('INSERT INTO ops_orders(store,external_id,body,updated_at) VALUES(?,?,?,?)').run(store,record.external_id,record.body,new Date().toISOString());
    }
    for(const row of db.prepare('SELECT * FROM ops_orders').all())prepareInvoice(db,parse(row),user);
    const linked=autoLinkEmails(db,user);collectSupportIntakes(db);event(db,user,`Updated ${imported.length} order snapshots; automatically linked ${linked} emails`);return {count:imported.length,linked};
  });
}

function packFingerprint(items=[]) {return JSON.stringify(items.map(item=>({sku:item.sku,barcode:item.barcode??'',quantity:item.quantity})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));}
