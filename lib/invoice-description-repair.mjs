import {customQuoteInfo,invoiceDescription} from './custom-quote.mjs';
const financial=b=>JSON.stringify([b.title,b.contact,b.currency,b.amount,b.shippingCents,b.taxCents,(b.invoiceItems??b.items??[]).map(i=>[i.lineId,i.quantity,i.unitPriceCents,i.lineTotalCents])]);
const legacy=i=>Number.isSafeInteger(i.lineTotalCents)?`${i.title||i.sku} (${i.quantity} units)`:i.title||i.sku;

// Only an untouched, automatically generated draft can be corrected. Retain its
// complete prior contents and never adjust quantities, prices, tax or totals.
export function repairQuoteInvoiceDescriptions(db,row,user,invoiceId) {
  const items=row.body.invoiceItems??row.body.items??[];if(!items.some(i=>customQuoteInfo(i).encoded))return false;
  const record=db.prepare("SELECT * FROM records WHERE id=? AND type='invoice'").get(invoiceId),mapping=db.prepare('SELECT order_snapshot FROM ops_invoices WHERE record_id=?').get(invoiceId);
  if(!record||record.version!==1||!mapping)return false;
  const body=JSON.parse(record.body),original=JSON.parse(mapping.order_snapshot),oldItems=original.invoiceItems??original.items??[];
  if(body.status!=='draft'||financial(original)!==financial(row.body)||body.items.length!==oldItems.length||body.items.some((i,index)=>i.description!==legacy(oldItems[index])))return false;
  const updated={...body,items:body.items.map((item,index)=>({...item,description:invoiceDescription(items[index])}))};
  if(updated.items.some(i=>i.description.length>300)||JSON.stringify(updated)===record.body)return false;
  const at=new Date().toISOString();
  db.prepare('INSERT INTO ops_invoice_description_history(record_id,version,body,user_id,at) VALUES(?,?,?,?,?)').run(invoiceId,record.version,record.body,user.id,at);
  db.prepare('UPDATE records SET body=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=1').run(JSON.stringify(updated),user.id,at,invoiceId);
  db.prepare('UPDATE ops_invoices SET order_snapshot=? WHERE record_id=?').run(JSON.stringify(row.body),invoiceId);
  db.prepare('INSERT INTO audit(user_id,record_id,action,at) VALUES(?,?,?,?)').run(user.id,invoiceId,'Corrected generated custom-quote descriptions; invoice quantities and all amounts preserved',at);
  return true;
}
