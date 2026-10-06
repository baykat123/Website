import { randomUUID } from 'node:crypto';
import { RequestError, requireOwner, event } from './team.mjs';

const decode = row => row && ({ ...row, original: JSON.parse(row.original), body: JSON.parse(row.body) });
function validate(kind, value) {
  if (!['gmail_send', 'shopify_publish'].includes(kind)) throw new RequestError(400, 'Unknown proposed action');
  const fields = kind === 'gmail_send' ? { to: 254, subject: 160, content: 10000 } : { title: 160, description: 10000 };
  const result = {};
  for (const [key, max] of Object.entries(fields)) {
    if (typeof value?.[key] !== 'string' || !value[key].trim() || value[key].length > max) throw new RequestError(400, `${key} is required and must be at most ${max} characters`);
    result[key] = value[key].trim();
  }
  if (kind === 'gmail_send' && (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result.to) || /[\r\n]/.test(result.to + result.subject))) throw new RequestError(400, 'Use one valid recipient and a single-line subject');
  return result;
}
export async function handleProposals({ db, path, req, body, user, json, integrations }) {
  if (!path.startsWith('/api/proposals')) return false;
  requireOwner(user);
  if (req.method === 'GET' && path === '/api/proposals') {
    json(200, { mode: 'approval_required', execution: integrations.capabilities().gmailSendEnabled?'approval_first_live_email':'simulation_only', gmailSendEnabled:integrations.capabilities().gmailSendEnabled, proposals: db.prepare('SELECT * FROM proposals ORDER BY id DESC').all().map(decode) }); return true;
  }
  if (req.method === 'GET' && path === '/api/proposals/learning') {
    const rows = db.prepare("SELECT proposal_feedback.*,proposals.kind FROM proposal_feedback JOIN proposals ON proposals.id=proposal_feedback.proposal_id WHERE decision='approved' AND proposals.status IN ('approved','simulated','sent') AND proposal_feedback.after=proposals.body ORDER BY proposal_feedback.id DESC LIMIT 50").all();
    json(200, { automatic: false, description: 'Approved corrections can be reused for identical draft text. No model training or automatic actions run.', examples: rows.map(row => ({ ...row, before: JSON.parse(row.before), after: JSON.parse(row.after) })) }); return true;
  }
  if (req.method === 'POST' && path === '/api/proposals') {
    const record = db.prepare('SELECT * FROM records WHERE id=?').get(body.recordId);
    if (!record || !['message','product'].includes(record.type)) throw new RequestError(400, 'Choose an email or product draft');
    const kind = record.type === 'message' ? 'gmail_send' : 'shopify_publish';
    const source = JSON.parse(record.body);
    const data = validate(kind, body.payload ?? (kind === 'gmail_send' ? { to: source.contact, subject: source.title, content: source.notes } : { title: source.title, description: source.notes }));
    let suggestion = data;
    const example = db.prepare("SELECT proposal_feedback.before,proposal_feedback.after FROM proposal_feedback JOIN proposals ON proposals.id=proposal_feedback.proposal_id WHERE decision='approved' AND proposals.kind=? AND proposals.status IN ('approved','simulated','sent') AND proposal_feedback.after=proposals.body ORDER BY proposal_feedback.id DESC LIMIT 50").all(kind).find(row => {
      const before = JSON.parse(row.before);
      const keys = kind === 'gmail_send' ? ['subject','content'] : ['title','description'];
      return keys.every(key => before[key] === data[key]);
    });
    if (example) {
      const correction = JSON.parse(example.after);
      suggestion = kind === 'gmail_send' ? { ...data, subject: correction.subject, content: correction.content } : correction;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare("SELECT id FROM proposals WHERE record_id=? AND status NOT IN ('rejected','simulated')").get(record.id);
      if (existing) throw new RequestError(409, 'This draft already has an active proposal');
      const now = new Date().toISOString();
      const id = Number(db.prepare("INSERT INTO proposals(record_id,kind,original,body,status,created_by,updated_at,operation_key) VALUES(?,?,?,?, 'pending',?,?,?)").run(record.id,kind,JSON.stringify(data),JSON.stringify(suggestion),user.id,now,randomUUID()).lastInsertRowid);
      event(db,user,`Prepared ${kind} proposal #${id}; approval required`);
      db.exec('COMMIT'); json(201,decode(db.prepare('SELECT * FROM proposals WHERE id=?').get(id)));
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    return true;
  }
  const execution=path.match(/^\/api\/proposals\/(\d+)\/(execute|reconcile)$/);
  if(req.method==='POST'&&execution){
    const proposal=decode(db.prepare('SELECT * FROM proposals WHERE id=?').get(Number(execution[1])));
    if(!proposal)throw new RequestError(404,'Proposal not found');
    if(proposal.kind!=='gmail_send')throw new RequestError(409,'This proposed action has no live executor yet');
    if(body.version!==proposal.version)throw new RequestError(409,'Proposal changed. Refresh before executing');
    if(execution[2]==='execute'&&proposal.status!=='approved')throw new RequestError(409,'Approve the exact proposal before sending');
    if(execution[2]==='reconcile'&&proposal.status!=='unknown')throw new RequestError(409,'Only uncertain sends can be reconciled');
    if(execution[2]==='execute')db.prepare("UPDATE proposals SET status='executing',version=version+1 WHERE id=?").run(proposal.id);
    try{
      const result=execution[2]==='execute'?await integrations.sendGmail(proposal.body,proposal.operation_key):await integrations.reconcileGmail(proposal.operation_key);
      db.prepare("UPDATE proposals SET status='sent',version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(),proposal.id);
      event(db,user,`Sent email proposal #${proposal.id}; Gmail message ${result.id}`);
      json(200,decode(db.prepare('SELECT * FROM proposals WHERE id=?').get(proposal.id)));return true;
    }catch(error){
      if(execution[2]==='execute')db.prepare('UPDATE proposals SET status=?,updated_at=? WHERE id=?').run(error.unknown?'unknown':'approved',new Date().toISOString(),proposal.id);
      event(db,user,`Email proposal #${proposal.id}: ${error.unknown?'unknown outcome; no retry':'send not completed'}`);throw error;
    }
  }
  const match = path.match(/^\/api\/proposals\/(\d+)\/(edit|approve|reject|simulate)$/);
  if (req.method !== 'POST' || !match) return false;
  const proposal = decode(db.prepare('SELECT * FROM proposals WHERE id=?').get(Number(match[1])));
  if (!proposal) throw new RequestError(404, 'Proposal not found');
  if (body.version !== proposal.version) throw new RequestError(409, 'Proposal changed. Refresh before trying again.');
  const action = match[2];
  if (action === 'simulate' && proposal.status === 'simulated') { json(200,proposal); return true; }
  if (action==='edit'&&!['pending','approved'].includes(proposal.status)) throw new RequestError(409,'A sent, executing, uncertain, or closed proposal cannot be edited');
  if (['rejected','simulated','sent','executing','unknown'].includes(proposal.status)) throw new RequestError(409, 'This proposal is closed');
  if (action === 'simulate' && proposal.status !== 'approved') throw new RequestError(409, 'Approve the exact proposal before simulating');
  if (['approve','reject'].includes(action) && proposal.status !== 'pending') throw new RequestError(409, 'Only pending proposals can be reviewed');
  const data = action === 'edit' ? validate(proposal.kind,body.payload) : proposal.body;
  const note = body.note ?? '';
  if (typeof note !== 'string' || note.length > 2000) throw new RequestError(400, 'Feedback must be at most 2000 characters');
  const status = {edit:'pending',approve:'approved',reject:'rejected',simulate:'simulated'}[action];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE proposals SET body=?,status=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data),status,new Date().toISOString(),proposal.id);
    if (action !== 'simulate') db.prepare('INSERT INTO proposal_feedback(proposal_id,user_id,decision,before,after,note,at) VALUES(?,?,?,?,?,?,?)').run(proposal.id,user.id,action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'edited',JSON.stringify(action === 'edit' ? proposal.body : proposal.original),JSON.stringify(data),note,new Date().toISOString());
    event(db,user,`${action} proposal #${proposal.id}${action === 'simulate' ? '; simulation only, no provider request' : ''}`);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  json(200,decode(db.prepare('SELECT * FROM proposals WHERE id=?').get(proposal.id))); return true;
}
