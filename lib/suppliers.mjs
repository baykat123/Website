import {RequestError,requireOwner,event} from './team.mjs';
const now=()=>new Date().toISOString();
const text=(value,max=200,required=true)=>{if(typeof value!=='string'||value.length>max||required&&!value.trim())throw new RequestError(400,'Supplier order information is missing or too long');return value.trim();};
function payload(input) {
  if(!['prm','usa'].includes(input.supplier)||!['CAD','USD'].includes(input.currency))throw new RequestError(400,'Choose the supplier account and currency');
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>100)throw new RequestError(400,'Add 1–100 purchase order lines');
  const items=input.items.map(item=>{
    const quantity=Number(item.quantity),unitCostCents=Number(item.unitCostCents);
    if(!Number.isSafeInteger(quantity)||quantity<1||quantity>10000||!Number.isSafeInteger(unitCostCents)||unitCostCents<0||unitCostCents>100000000)throw new RequestError(400,'Valid whole quantities and costs are required');
    return {sku:text(item.sku),supplierSku:text(item.supplierSku),barcode:text(item.barcode??'',200,false),title:text(item.title),quantity,unitCostCents};
  });
  if(new Set(items.map(item=>item.sku)).size!==items.length)throw new RequestError(400,'Combine repeated SKUs into one purchase order line');
  if(items.some(item=>item.barcode&&items.some(other=>other!==item&&(other.barcode===item.barcode||other.sku===item.barcode)))||items.some(item=>items.some(other=>other!==item&&other.barcode===item.sku)))throw new RequestError(400,'Resolve ambiguous barcode/SKU mappings before saving');
  const totalCents=items.reduce((sum,item)=>sum+item.quantity*item.unitCostCents,0);if(!Number.isSafeInteger(totalCents))throw new RequestError(400,'Purchase order total is too large');
  const expectedDate=text(input.expectedDate??'',10,false);if(expectedDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)||Number.isNaN(Date.parse(expectedDate))||new Date(expectedDate).toISOString().slice(0,10)!==expectedDate))throw new RequestError(400,'Expected date must be a valid YYYY-MM-DD date');
  return {title:text(input.title,160),currency:input.currency,items,totalCents,expectedDate,notes:text(input.notes??'',10000,false),sampleData:input.sampleData===true};
}
const parse=row=>row&&{...row,body:JSON.parse(row.body)};
function transact(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
export function handleSuppliers({db,path,req,body,user,json}) {
  if(!path.startsWith('/api/supplier'))return false;
  if(!user)throw new RequestError(401,'Sign in required');
  function history(id,action){const row=db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(id);db.prepare('INSERT INTO supplier_order_versions VALUES(?,?,?,?,?,?,?)').run(id,row.version,row.body,row.status,user.id,action,now());}
  function view(row){const receipts=db.prepare('SELECT supplier_receipts.*,users.username FROM supplier_receipts JOIN users ON users.id=supplier_receipts.user_id WHERE supplier_order_id=? ORDER BY supplier_receipts.id').all(row.id),history=db.prepare('SELECT * FROM supplier_order_versions WHERE supplier_order_id=? ORDER BY version').all(row.id).map(parse);return {...parse(row),receipts,history};}
  if(req.method==='GET'&&path==='/api/supplier-orders'){json(200,{apiStatus:'pending',orders:db.prepare('SELECT * FROM supplier_orders ORDER BY id DESC').all().map(view)});return true;}
  if(req.method==='POST'&&path==='/api/supplier-orders'){
    const data=payload(body);let sourceId=null;
    if(body.sourceOrderId){const order=parse(db.prepare('SELECT * FROM ops_orders WHERE id=?').get(Number(body.sourceOrderId)));if(!order||body.supplier!=='usa')throw new RequestError(400,'USA supplier preparation requires an existing order');
      if(order.body.cancelledAt||['REFUNDED','VOIDED'].includes(order.body.financialStatus)||order.body.fulfillmentStatus==='FULFILLED')throw new RequestError(409,'This customer order is not eligible for supplier preparation');
      const usaAccount=db.prepare("SELECT account FROM connections WHERE provider='shopify_usa'").get()?.account;
      if(!order.body.sampleData&&(!usaAccount||order.store!==usaAccount))throw new RequestError(409,'Choose an order from the connected USA store');
      if(data.items.length!==order.body.items?.length||!data.items.every(item=>order.body.items.some(expected=>expected.sku===item.sku&&expected.quantity===item.quantity)))throw new RequestError(409,'Purchase quantities must match the complete customer order');
      sourceId=order.id;data.customerOrder={store:order.store,externalId:order.external_id,snapshot:order.body};
      if(db.prepare("SELECT id FROM supplier_orders WHERE source_order_id=? AND status!='rejected'").get(sourceId))throw new RequestError(409,'This customer order already has an active supplier request');
      if(data.sampleData&&order.body.sampleData!==true)throw new RequestError(409,'Sample supplier simulation cannot use a real customer order');
    }
    const id=transact(db,()=>{const id=Number(db.prepare("INSERT INTO supplier_orders(supplier,body,source_order_id,created_by,updated_at) VALUES(?,?,?,?,?)").run(body.supplier,JSON.stringify(data),sourceId,user.id,now()).lastInsertRowid);history(id,'create');event(db,user,`Prepared supplier order #${id}; no supplier submission`);return id;});json(201,view(db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(id)));return true;
  }
  const match=path.match(/^\/api\/supplier-orders\/(\d+)\/(edit|submit|approve|reject|simulate|receive)$/);
  if(req.method!=='POST'||!match)return false;
  const row=parse(db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(Number(match[1])));if(!row)throw new RequestError(404,'Supplier order not found');
  const action=match[2];if(action!=='receive'&&body.version!==row.version)throw new RequestError(409,'Supplier order changed; refresh before continuing');
  if(['approve','reject','simulate'].includes(action))requireOwner(user);
  if(action==='receive'){
    if(!row.body.sampleData||!['simulated','received_sample'].includes(row.status))throw new RequestError(409,'Supplier API access is pending. Only confirmed sample inbound orders can be received in this test workflow');
    const code=text(body.code),key=text(body.scanId,100),serial=text(body.serialNumber??'',160,false),note=text(body.note??'',2000,false);
    if(!['good','damaged'].includes(body.condition)||body.condition==='damaged'&&!note)throw new RequestError(400,'Choose item condition and describe any damage');
    const line=row.body.items.find(item=>item.sku===code||item.barcode===code);if(!line)throw new RequestError(400,'Scanned item is not expected on this inbound order');
    const duplicate=db.prepare('SELECT * FROM supplier_receipts WHERE scan_key=?').get(key);
    if(duplicate){if(duplicate.supplier_order_id!==row.id||duplicate.sku!==line.sku||duplicate.condition!==body.condition||(duplicate.serial_number??'')!==serial||duplicate.note!==note)throw new RequestError(409,'Receipt scan key belongs to different evidence');json(200,{duplicate:true});return true;}
    if(serial&&db.prepare('SELECT id FROM supplier_receipts WHERE serial_number=?').get(serial))throw new RequestError(409,'This serial number has already been received');
    if(db.prepare('SELECT COUNT(*) AS n FROM supplier_receipts WHERE supplier_order_id=? AND sku=?').get(row.id,line.sku).n>=line.quantity)throw new RequestError(409,'All expected units of this SKU have already been received');
    transact(db,()=>{db.prepare('INSERT INTO supplier_receipts(supplier_order_id,sku,scan_key,serial_number,condition,note,user_id,at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,line.sku,key,serial||null,body.condition,note,user.id,now());
      const complete=row.body.items.every(item=>db.prepare('SELECT COUNT(*) AS n FROM supplier_receipts WHERE supplier_order_id=? AND sku=?').get(row.id,item.sku).n===item.quantity);
      db.prepare('UPDATE supplier_orders SET status=?,version=version+1,updated_at=? WHERE id=?').run(complete?'received_sample':'simulated',now(),row.id);history(row.id,'receive');event(db,user,`Scanned sample inbound ${line.sku}: ${body.condition}; no live inventory update`);
    });json(201,view(db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(row.id)));return true;
  }
  const allowed={edit:['draft','rejected','review','approved'],submit:['draft','rejected'],approve:['review'],reject:['review','approved'],simulate:['approved']};
  if(!allowed[action].includes(row.status))throw new RequestError(409,'This supplier order cannot take that action');
  let data=row.body,status={submit:'review',approve:'approved',reject:'rejected',simulate:'simulated',edit:'draft'}[action];
  if(row.source_order_id&&status!=='rejected'&&db.prepare("SELECT id FROM supplier_orders WHERE source_order_id=? AND id!=? AND status!='rejected'").get(row.source_order_id,row.id))throw new RequestError(409,'This customer order already has another active supplier request');
  if(action==='edit'){data=payload({...body.payload,supplier:row.supplier});if(data.sampleData!==row.body.sampleData)throw new RequestError(409,'Sample status cannot be changed');if(row.source_order_id)throw new RequestError(409,'Prepare a new USA request from the updated customer order instead of changing its source snapshot');}
  if(action==='simulate'&&!row.body.sampleData)throw new RequestError(409,'Supplier API access is pending. Simulation accepts fictional purchase orders only');
  if(['approve','simulate'].includes(action)&&row.source_order_id){const current=parse(db.prepare('SELECT * FROM ops_orders WHERE id=?').get(row.source_order_id));if(JSON.stringify(current.body)!==JSON.stringify(row.body.customerOrder.snapshot))throw new RequestError(409,'Customer order changed; prepare a new supplier request');}
  transact(db,()=>{db.prepare('UPDATE supplier_orders SET body=?,status=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),status,now(),row.id);history(row.id,action);event(db,user,`${action} supplier order #${row.id}; ${action==='simulate'?'sample simulation':'no supplier submission'}`);});
  json(200,view(db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(row.id)));return true;
}
