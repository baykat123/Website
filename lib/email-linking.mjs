import { event } from './team.mjs';
const emailAddress=value=>(String(value??'').match(/<?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i)?.[1]??'').toLowerCase();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function emailSuggestions(db,{orderId}={}) {
  const emails=db.prepare("SELECT * FROM external_records WHERE provider='gmail' AND type='message'").all();
  const orders=db.prepare('SELECT * FROM ops_orders').all().map(row=>{const body=JSON.parse(row.body);return {...row,body,referencePattern:body.title?new RegExp(`(^|[^A-Za-z0-9])${escape(body.title)}(?=$|[^A-Za-z0-9])`,'i'):null};});
  const target=orderId===undefined?null:orders.find(order=>order.id===orderId);if(orderId!==undefined&&!target)return [];
  const results=[];
  for(const email of emails) {
    const body=JSON.parse(email.body),text=`${body.title ?? ''}\n${body.notes ?? ''}`;
    if(target&&!target.referencePattern?.test(text))continue;
    const matches=orders.filter(order=>order.referencePattern?.test(text));
    for(const order of matches){
      if(target&&order.id!==target.id)continue;
      const linked=db.prepare('SELECT external_id FROM ops_emails WHERE order_id=? AND external_id=?').get(order.id,email.external_id),decision=db.prepare('SELECT decision FROM ops_email_decisions WHERE order_id=? AND email_id=?').get(order.id,email.external_id);
      if(linked||decision?.decision==='rejected')continue;
      const sameCustomer=!!emailAddress(order.body.contact)&&emailAddress(order.body.contact)===emailAddress(body.contact);
      results.push({emailId:email.external_id,orderId:order.id,orderTitle:order.body.title,store:order.store,email:body,autoLink:matches.length===1&&sameCustomer,reason:matches.length>1?'Order reference matches multiple stores/orders':sameCustomer?'Exact order reference and customer email match':'Order reference found; customer identity needs review'});
    }
  }
  return results;
}
export function linkEmail(db,user,orderId,emailId,body,kind='manual') {
  const now=new Date().toISOString();
  const result=db.prepare('INSERT OR IGNORE INTO ops_emails(order_id,external_id,snapshot,linked_by,linked_at) VALUES(?,?,?,?,?)').run(orderId,emailId,JSON.stringify(body),user.id,now);
  if(result.changes){
    db.prepare("INSERT INTO ops_notes(order_id,user_id,kind,content,email_id,created_at) VALUES(?,?,'email',?,?,?)").run(orderId,user.id,`${body.title}\n${body.contact ?? ''}\n${body.notes ?? ''}`,emailId,now);
    event(db,user,`${kind==='automatic'?'Automatically linked':'Linked'} email to order desk #${orderId}`);
  }
}
export function autoLinkEmails(db,user) {const suggestions=emailSuggestions(db);let count=0;for(const suggestion of suggestions.filter(item=>item.autoLink)){linkEmail(db,user,suggestion.orderId,suggestion.emailId,suggestion.email,'automatic');count++;}return count;}
