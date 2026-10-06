import {randomUUID} from 'node:crypto';
import {RequestError,requireOwner,event} from './team.mjs';
const text=(value,max,required=true)=>{if(typeof value!=='string'||value.length>max||required&&!value.trim())throw new RequestError(400,'Required support information is missing or too long');return value.trim();};
const address=value=>String(value??'').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()??'';
export function collectSupportIntakes(db) {
  let count=0;
  for(const email of db.prepare("SELECT * FROM external_records WHERE provider='gmail' AND type='message'").all()){
    const b=JSON.parse(email.body);if(!/warranty|claim|repair|defective|not working|not turning on|damaged|support request/i.test(b.title??''))continue;
    const category=/warranty|defective|not working|not turning on/i.test(b.title)?'warranty':/damaged/i.test(b.title)?'shipping':'support';
    const result=db.prepare("INSERT OR IGNORE INTO support_intakes(id,source,email_id,email,subject,details,serial_number,order_reference,category,status,created_at) VALUES(?,'gmail',?,?,?,?, '','',?,'pending',?)").run(randomUUID(),email.external_id,address(b.contact),b.title,b.notes??'',category,new Date().toISOString());count+=Number(result.changes);
  }return count;
}
export function createSupportHandler(db) {
  const limits=new Map();
  return function handle({path,req,body,user,json}) {
    if(!path.startsWith('/api/support'))return false;
    if(req.method==='POST'&&path==='/api/support/request'){
      const email=text(body.email,254),subject=text(body.subject,160),details=text(body.details,10000),reference=text(body.orderReference??'',160,false),serial=text(body.serialNumber??'',160,false);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['support','warranty','return','shipping'].includes(body.category))throw new RequestError(400,'Valid email and support category are required');
      const now=Date.now();for(const [key,value]of limits)if(value.until<now)limits.delete(key);
      const key=req.socket.remoteAddress,limit=limits.get(key)??{count:0,until:now+3600000};if(limit.count>=20)throw new RequestError(429,'Please wait before submitting another support request');limit.count++;limits.set(key,limit);
      if(!body.website)db.prepare("INSERT INTO support_intakes(id,source,email,subject,details,serial_number,order_reference,category,status,created_at) VALUES(?,'customer_form',?,?,?,?,?,?,'pending',?)").run(randomUUID(),email.toLowerCase(),subject,details,serial,reference,body.category,new Date().toISOString());
      // Do not reveal whether a customer-supplied order reference or email exists.
      json(202,{message:'Your request was received for review.'});return true;
    }
    requireOwner(user);
    if(req.method==='GET'&&path==='/api/support/intakes'){json(200,db.prepare('SELECT * FROM support_intakes ORDER BY created_at DESC').all());return true;}
    const match=path.match(/^\/api\/support\/intakes\/([a-f0-9-]+)\/(convert|dismiss)$/);
    if(req.method==='POST'&&match){const intake=db.prepare('SELECT * FROM support_intakes WHERE id=?').get(match[1]);if(!intake)throw new RequestError(404,'Support intake not found');if(body.version!==intake.version||intake.status!=='pending')throw new RequestError(409,'Intake changed or was already reviewed');
      db.exec('BEGIN IMMEDIATE');
      try{
        let ticketId=null;
        if(match[2]==='convert'){
          const order=db.prepare('SELECT * FROM ops_orders WHERE id=?').get(body.orderId);if(!order)throw new RequestError(400,'Choose the verified customer order before creating a case');
          const details=`Customer email (unverified): ${intake.email}\nSerial: ${intake.serial_number||'not provided'}\n${intake.details}`;
          ticketId=Number(db.prepare("INSERT INTO ops_tickets(order_id,title,details,category,status,created_by,created_at,updated_at) VALUES(?,?,?,?, 'open',?,?,?)").run(order.id,intake.subject,details,intake.category,user.id,new Date().toISOString(),new Date().toISOString()).lastInsertRowid);
          db.prepare("INSERT INTO ops_notes(order_id,user_id,kind,content,created_at) VALUES(?,?,'ticket',?,?)").run(order.id,user.id,`Support intake reviewed and attached as ticket #${ticketId}: ${intake.subject}`,new Date().toISOString());
        }
        db.prepare('UPDATE support_intakes SET status=?,ticket_id=?,version=version+1 WHERE id=?').run(match[2]==='convert'?'converted':'dismissed',ticketId,intake.id);event(db,user,`${match[2]} support intake ${intake.id}`);db.exec('COMMIT');json(200,{ticketId,status:match[2]==='convert'?'converted':'dismissed'});
      }catch(error){db.exec('ROLLBACK');throw error;}return true;
    }return false;
  };
}
