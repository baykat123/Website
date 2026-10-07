const $ = selector => document.querySelector(selector);
const areas = [['overview','Overview'],['orderdesk','Order desk'],['tickets','Support & warranty'],['packages','Saved packages'],['shipping','Shipping setup & jobs'],['suppliers','Bambu purchases & receiving'],['quote','Quotes'],['order','Orders'],['invoice','Invoices'],['task','Follow-ups & marketing'],['message','Email drafts'],['shipment','Dropship shipments'],['product','Product drafts'],['approvals','Review queue'],['proposals','Action approvals'],['connections','Connections'],['team','Team & account'],['audit','Activity']];
const requestedView = new URLSearchParams(location.search).get('view');
let area = areas.some(entry=>entry[0]===requestedView) ? requestedView : 'overview', records = [], noticeTimer, editing = null, currentUser = null;
let inviteToken = location.pathname === '/join' ? new URLSearchParams(location.search).get('token') : null;
if (inviteToken) history.replaceState(null,'','/join');
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function notice(message) { $('#notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').textContent = '', 6000); }
async function api(path, body) {
  const response = await fetch(path, { signal: AbortSignal.timeout(/\/(sync|rates|book|reconcile|retry-tracking|execute|permissions)$/.test(path) ? 120000 : 10000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('The app server could not be reached. Open the app through its running server, rather than a file or static preview.');
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/login') showLogin(); throw new Error(data.error ?? 'Request failed'); }
  return data;
}
function showLogin() { records = []; $('#records').replaceChildren(); $('#stats').replaceChildren(); $('#editor').close(); $('#workspace').hidden = true; $('#login').hidden = false; }
async function start(user) { currentUser = user; $('#user').textContent = `${user.username} · ${user.role}`; $('#join').hidden = true; $('#login').hidden = true; $('#workspace').hidden = false; await refresh(); }
async function refresh() { records = await api('/api/records'); await render(); }
const readable = status => status.replaceAll('_', ' ');
function money(cents, currency) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100); } catch { return `${currency} ${(cents / 100).toFixed(2)}`; } }
async function action(record, kind, status) {
  const buttonList = $('#records').querySelectorAll('button'); buttonList.forEach(button => button.disabled = true);
  try { await api(`/api/records/${record.id}/${kind}`, { version: record.version, status }); await refresh(); notice(kind === 'convert' ? 'Created a new draft. No external action was taken.' : 'Record updated.'); }
  catch (error) { notice(error.message); if ($('#workspace').hidden === false) await refresh().catch(() => {}); }
  finally { buttonList.forEach(button => button.disabled = false); }
}
async function render() {
  history.replaceState(null,'',`/?view=${area}`);
  $('#nav').querySelectorAll('button').forEach((node,index) => node.classList.toggle('active',areas[index][0] === area));
  $('#heading').textContent = areas.find(entry => entry[0] === area)[1];
  $('#new-record').hidden = ['audit','connections','team','proposals','orderdesk','tickets','packages','shipping','suppliers'].includes(area);
  $('.toolbar').hidden = ['audit','connections','team','proposals','orderdesk','tickets','packages','shipping','suppliers'].includes(area);
  $('#stats').replaceChildren();
  const today = new Date().toLocaleDateString('en-CA');
  const overdue = records.filter(record => record.body.due && record.body.due < today && !['done','paid','fulfilled','delivered'].includes(record.body.status));
  const stats = [['Shared records', records.length, 'all'], ['Awaiting review', records.filter(record => record.body.status === 'pending_review').length, 'review'], ['Past due', overdue.length, 'overdue']];
  for (const [label, count, target] of stats) {
    const card = el('button',undefined,'stat'); card.append(el('span',label),el('strong',String(count)));
    card.onclick = () => { area = target === 'review' ? 'approvals' : 'overview'; $('#filter').value = ''; $('#search').value = ''; $('#work-filter').value = target === 'overdue' ? 'overdue' : ''; $('#nav').querySelectorAll('button').forEach((node,index) => node.classList.toggle('active',areas[index][0] === area)); render().catch(error => notice(error.message)); };
    $('#stats').append(card);
  }
  const container = $('#records'); container.replaceChildren();
  if (area === 'shipping') { await renderShipping(container); return; }
  if (area === 'packages') { await renderPackages(container); return; }
  if (area === 'orderdesk') { await renderOrderDesk(container); return; }
  if (area === 'tickets') { await renderTickets(container); return; }
  if (area === 'proposals') { await renderProposals(container); return; }
  if (area === 'team') { await renderTeam(container); return; }
  if (area === 'suppliers') { await renderSuppliers(container); return; }
  if (area === 'connections') { await renderConnections(container); return; }
  if (area === 'audit') {
    const events = await api('/api/audit');
    for (const event of events) container.append(el('div',`${event.username}${event.record_id ? ` · #${event.record_id}` : ''} · ${event.action} · ${new Date(event.at).toLocaleString()}`,'audit'));
    if (!events.length) container.append(el('p','Activity will appear after records are created.'));
    return;
  }
  const search = $('#search').value.toLowerCase(), status = $('#filter').value;
  const work = $('#work-filter').value;
  const shown = records.filter(record => (!work || work === 'mine' && record.body.assignee === currentUser.username || work === 'overdue' && overdue.includes(record)) && (area === 'overview' || area === record.type || area === 'approvals' && record.body.status === 'pending_review') && (!status || record.body.status === status) && [record.body.title,record.body.contact,record.body.notes,record.body.assignee].join(' ').toLowerCase().includes(search));
  if (!shown.length) { const empty = el('div',undefined,'empty'); empty.append(el('h2','No matching records'),el('p','Create a record to begin, or adjust your search.')); container.append(empty); }
  for (const record of shown) {
    const b = record.body, card = el('article',undefined,'record'), head = el('div',undefined,'record-heading'), left = el('div');
    left.append(el('h2',b.title),el('div',[`${record.type} #${record.id}`,b.contact,b.assignee && `Assigned: ${b.assignee}`,b.due && `Due: ${b.due}`].filter(Boolean).join(' · '),'meta'));
    head.append(left,el('span',readable(b.status),`badge${b.status === 'pending_review' ? ' review' : ''}`)); card.append(head);
    for (const [label, id] of [['Source',record.source_id],['Next record',record.target_id]]) {
      if (!id) continue;
      const linked = records.find(entry => entry.id === id), link = el('button',`${label}: ${linked?.type ?? 'record'} #${id}`,'quiet record-link');
      link.onclick = () => { area = 'overview'; $('#search').value = ''; $('#filter').value = ''; $('#work-filter').value = ''; render().then(() => document.getElementById(`record-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'})).catch(error => notice(error.message)); };
      card.append(link);
    }
    card.id = `record-${record.id}`;
    if (b.items) {
      const table = el('table'), header = el('tr'); ['Description','Qty','Unit price','Total'].forEach(label => header.append(el('th',label))); table.append(header);
      for (const item of b.items) { const row = el('tr'); [item.description,String(item.quantity),money(item.unitPriceCents,b.currency),money(item.quantity*item.unitPriceCents,b.currency)].forEach(value => row.append(el('td',value))); table.append(row); }
      card.append(table,el('div',`Shipping ${money(b.shippingCents,b.currency)} · Tax ${money(b.taxCents,b.currency)}`,'meta'),el('div',money(b.totalCents,b.currency),'total'));
    }
    if (b.supplier || b.tracking) card.append(el('div',[b.supplier && `Supplier: ${b.supplier}`, b.tracking && `Tracking: ${b.tracking}`].filter(Boolean).join(' · '),'meta'));
    if (b.notes) card.append(el('p',b.notes,'notes'));
    const buttons = el('div',undefined,'actions');
    if (['draft','open','in_progress','ordered','shipped'].includes(b.status)) { const edit = el('button','Edit','quiet'); edit.onclick = () => openEditor(record); buttons.append(edit); }
    const choices = { draft: [['Submit for review','pending_review']], pending_review: [['Approve record','approved'],['Return to draft','draft']], open: record.type === 'task' ? [['Start task','in_progress'],['Complete task','done']] : [['Mark ordered','ordered']], in_progress: [['Complete task','done']], ordered: [['Mark shipped','shipped']], shipped: [['Mark delivered','delivered']], done: [['Reopen','open']], approved: record.type === 'order' ? [] : record.type === 'invoice' ? [['Mark paid','paid']] : [] };
    for (const [label,target] of choices[b.status] ?? []) { const button = el('button',label,'quiet'); button.onclick = () => action(record,'status',target); buttons.append(button); }
    if (['approved','fulfilled'].includes(b.status) && ['quote','order'].includes(record.type)) { const button = el('button',record.target_id ? 'Open existing draft' : record.type === 'quote' ? 'Create order draft' : 'Create invoice draft'); button.onclick = () => { if (!record.target_id) return action(record,'convert'); area = 'overview'; $('#search').value = ''; $('#filter').value = ''; $('#work-filter').value = ''; render().then(() => document.getElementById(`record-${record.target_id}`)?.scrollIntoView({behavior:'smooth',block:'center'})).catch(error => notice(error.message)); }; buttons.append(button); }
    if (currentUser.role === 'owner' && ['message','product'].includes(record.type)) {
      const prepare = el('button','Prepare action for approval');
      prepare.onclick = async () => { prepare.disabled = true; try { await api('/api/proposals',{recordId:record.id}); area = 'proposals'; await render(); notice('Proposal prepared. Review its exact contents before approving.'); } catch(error) { notice(error.message); } finally { prepare.disabled = false; } };
      buttons.append(prepare);
    }
    if (['quote','order','invoice'].includes(record.type)) {
      const download=el('a','Download PDF','authorization-link');download.href=`/api/records/${record.id}/pdf`;download.download=`${record.type}-${record.id}.pdf`;buttons.append(download);
    }
    card.append(buttons); container.append(card);
  }
}
for (const [id,label] of areas) { const button = el('button',label,id === area ? 'active' : ''); button.onclick = async () => { area = id; $('#nav').querySelectorAll('button').forEach(node => node.classList.toggle('active',node === button)); $('#filter').value = ''; $('#work-filter').value = ''; await render().catch(error => notice(error.message)); }; $('#nav').append(button); }
$('#login-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; try { const user = await api('/api/login',Object.fromEntries(new FormData(form))); form.reset(); await start(user); } catch (error) { notice(error.message); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/api/logout',{}); showLogin(); } catch(error) { notice(error.message); } };
$('#search').oninput = () => render().catch(error => notice(error.message));
$('#work-filter').onchange = () => render().catch(error => notice(error.message));
$('#filter').onchange = () => render().catch(error => notice(error.message));
$('#refresh').onclick = () => refresh().catch(error => notice(error.message));
function addLine(item = {}) {
  const row = el('div',undefined,'line-item');
  for (const [name,placeholder,value,type] of [['description','Description','','text'],['quantity','Qty','1','number'],['unitPrice','Price','0.00','number']]) { const input = el('input'); input.dataset.field = name; input.placeholder = placeholder; input.setAttribute('aria-label',placeholder); input.value = item[name] ?? value; input.type = type; input.required = true; if (type === 'number') { input.min = name === 'quantity' ? '1' : '0'; input.step = name === 'quantity' ? '1' : '0.01'; } else input.maxLength = 300; row.append(input); }
  const remove = el('button','×','quiet'); remove.type = 'button'; remove.setAttribute('aria-label','Remove line'); remove.onclick = () => { row.remove(); updateTotal(); }; row.append(remove); $('#line-items').append(row); updateTotal();
}
function updateTotal() {
  const toCents = value => { if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) throw new Error(); const [whole,fraction=''] = value.split('.'); return Number(whole)*100 + Number(fraction.padEnd(2,'0')); };
  try {
    const rows = [...$('#line-items').children];
    if (!rows.length) throw new Error();
    const subtotal = rows.reduce((sum,row) => { const quantity = Number(row.querySelector('[data-field="quantity"]').value); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw new Error(); return sum + quantity * toCents(row.querySelector('[data-field="unitPrice"]').value); },0);
    const total = subtotal + toCents($('#record-form').elements.shipping.value || '0') + toCents($('#record-form').elements.tax.value || '0');
    if (!Number.isSafeInteger(total) || total > 100000000000) throw new Error();
    $('#sales-total').textContent = `Preview total: ${money(total,$('#record-form').elements.currency.value)}`;
  } catch { $('#sales-total').textContent = 'Enter valid quantities and amounts to preview the total.'; }
}
$('#record-form').addEventListener('input', updateTotal);
function updateFields() {
  const sale = ['quote','order','invoice'].includes($('#record-type').value);
  $('#sales-fields').hidden = !sale; $('#sales-fields').disabled = !sale;
  $('#shipment-fields').hidden = $('#record-type').value !== 'shipment';
}
function openEditor(record = null) {
  editing = record;
  const form = $('#record-form'); form.reset();
  form.querySelector('h2').textContent = record ? `Edit ${record.type} #${record.id}` : 'New record';
  $('#record-type').value = record?.type ?? (['overview','approvals','audit'].includes(area) ? 'task' : area);
  $('#record-type').disabled = !!record;
  $('#line-items').replaceChildren();
  if (record) {
    for (const [key,value] of Object.entries(record.body)) if (form.elements.namedItem(key) && typeof value === 'string') form.elements.namedItem(key).value = value;
    form.elements.shipping.value = ((record.body.shippingCents ?? 0)/100).toFixed(2);
    form.elements.tax.value = ((record.body.taxCents ?? 0)/100).toFixed(2);
    for (const item of record.body.items ?? []) addLine({ ...item, unitPrice:(item.unitPriceCents/100).toFixed(2) });
  }
  if (!$('#line-items').children.length) addLine();
  updateFields(); updateTotal(); $('#editor').showModal();
}
$('#new-record').onclick = () => openEditor();
$('#record-type').onchange = updateFields;
$('#add-line').onclick = () => addLine();
$('#close-editor').onclick = () => $('#editor').close();
$('#record-form').onsubmit = async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
  const body = Object.fromEntries(new FormData(event.currentTarget));
  if (editing) { body.type = editing.type; body.version = editing.version; }
  if (['quote','order','invoice'].includes(body.type)) body.items = [...$('#line-items').children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field,input.value])));
  try { await api(editing ? `/api/records/${editing.id}` : '/api/records',body); $('#editor').close(); await refresh(); notice('Record saved.'); } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
function field(label, name, type = 'text') {
  const wrapper = el('label',label), input = el('input'); input.name = name; input.type = type; input.required = true;
  if (type === 'password') { input.minLength = 14; input.maxLength = 1000; input.autocomplete = name === 'currentPassword' ? 'current-password' : 'new-password'; }
  wrapper.append(input); return wrapper;
}
async function renderTeam(container) {
  if (currentUser.role === 'owner') {
    const data = await api('/api/team'), card = el('section',undefined,'record'); card.append(el('h2','Team members'));
    for (const user of data.users) card.append(el('p',`${user.username} · ${user.role}${user.email ? ` · ${user.email}` : ''}`));
    const form = el('form'), email = field('Invite by email','email','email'), button = el('button','Create invitation link');
    const output = el('div');
    form.append(email,button); card.append(el('h2','Invite a teammate'),el('p','Links expire after 48 hours and can be used once. Share the link directly with that person; this app does not email invitations.'),form,output);
    form.onsubmit = async event => {
      event.preventDefault(); button.disabled = true;
      try {
        const result = await api('/api/team/invite',Object.fromEntries(new FormData(form))), input = el('input'); input.readOnly = true; input.value = location.origin + result.path; input.setAttribute('aria-label','Invitation link'); input.onclick = () => input.select();
        output.replaceChildren(el('p','Copy this private invitation link and send it to your teammate:'),input);
      } catch(error) { notice(error.message); } finally { button.disabled = false; }
    };
    container.append(card);
  } else container.append(el('p','Your workspace owner can invite additional teammates.'));
  const card = el('section',undefined,'record'), form = el('form'), button = el('button','Change password and sign out');
  card.append(el('h2','Change your password'),el('p','Use at least 14 characters. Changing your password ends all of your active sessions.'));
  const current = field('Current password','currentPassword','password'); current.querySelector('input').minLength = 1;
  form.append(current,field('New password','newPassword','password'),field('Confirm new password','confirmPassword','password'),button); card.append(form); container.append(card);
  form.onsubmit = async event => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(form));
    if (values.newPassword !== values.confirmPassword) return notice('The new passwords do not match.');
    button.disabled = true;
    try { await api('/api/password',values); form.reset(); showLogin(); notice('Password changed. Sign in with your new password.'); }
    catch(error) { notice(error.message); } finally { button.disabled = false; }
  };
}
async function renderConnections(container) {
  const connections = await api('/api/integrations');
  const monitoring = await api('/api/sync/status');
  container.append(el('p',monitoring.enabled ? `Account imports run every ${monitoring.intervalSeconds} seconds.` : 'Scheduled account imports are off. Use Sync now to refresh connected accounts.'));
  for (const connection of connections) {
    const card = el('section',undefined,'record'), name = connection.provider === 'gmail' ? 'Google Workspace Gmail' : connection.provider==='shopify_usa'?'Shopify USA':'Shopify Canada';
    card.append(el('h2',name),el('p',connection.connected ? `Connected: ${connection.account}` : connection.configured ? 'Ready to connect your account.' : 'Initial provider application setup is still required.'));
    card.append(el('p',connection.provider === 'gmail' ? 'Sync imports inbox message subjects, senders, and previews. Replies are prepared in Action approvals; sending requires an authorized sending connection and explicit approval.' : 'Sync imports accessible orders with complete line items and 25 recently updated products. Approved shipping writes tracking only when fulfillment permissions are authorized.'));
    if (connection.lastSync) card.append(el('div',`Last successful sync: ${new Date(connection.lastSync).toLocaleString()}`,'meta'));
    if(connection.provider!=='gmail'&&connection.connected)card.append(el('p',connection.fulfillmentEnabled?'Shopify fulfillment permissions authorized.':'Shopify fulfillment permission is pending; shipping cannot mark orders fulfilled yet.'));
    if (currentUser.role === 'owner') {
      const actions = el('div',undefined,'actions'), connect = el('button',connection.connected ? 'Reconnect' : `Connect ${connection.provider === 'gmail' ? 'Gmail' : connection.provider==='shopify_usa'?'Shopify USA':'Shopify Canada'}`);
      const feedback = el('p',undefined,'connection-feedback'); feedback.setAttribute('role','status');
      connect.disabled = !connection.configured;
      if (!connection.configured) {
        feedback.textContent = `Connection is unavailable until your ${connection.provider === 'gmail' ? 'Google' : 'Shopify'} application is configured in Render. No connection request is running.`;
        connect.title = 'Provider application setup is required';
      }
      connect.onclick = async () => {
        connect.disabled = true; connect.setAttribute('aria-busy','true'); feedback.textContent = 'Preparing your secure sign-in link…';
        try {
          const result = await api(`/api/integrations/${connection.provider}/connect`,{});
          const destination = new URL(result.url);
          const expectedHost = connection.provider === 'gmail' ? destination.hostname === 'accounts.google.com' : /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(destination.hostname);
          if (destination.protocol !== 'https:' || !expectedHost || destination.username || destination.password) throw new Error('The authorization address was unexpected. Try again or ask the workspace owner to check the connection setup.');
          const link = el('a',connection.provider === 'gmail' ? 'Continue to Google' : 'Continue to Shopify','authorization-link');
          link.href = destination.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          feedback.replaceChildren(el('span','Your sign-in link is ready. Open it in a new tab; it expires in 10 minutes. '),link);
        } catch(error) {
          feedback.textContent = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The app did not respond within 10 seconds. Refresh the page and try again; if it continues, check the Render service logs.' : error.message;
        } finally { connect.disabled = false; connect.removeAttribute('aria-busy'); }
      };
      actions.append(connect);
      if (connection.connected) {
        if(connection.provider!=='gmail'){const verify=el('button','Verify permissions','quiet');verify.onclick=async()=>{verify.disabled=true;try{await api(`/api/integrations/${connection.provider}/permissions`,{});await render();notice('Permissions verified with Shopify.');}catch(error){notice(error.message);verify.disabled=false;}};actions.append(verify);}
        const sync = el('button','Sync now','quiet'); sync.onclick = async () => { sync.disabled = true; sync.textContent = 'Syncing…'; try { const result = await api(`/api/integrations/${connection.provider}/sync`,{}); await render(); notice(`Imported ${result.count} records.`); } catch(error) { notice(error.message); } finally { sync.disabled = false; sync.textContent = 'Sync now'; } }; actions.append(sync);
        const disconnect = el('button','Disconnect','quiet'); disconnect.onclick = async () => { if (!confirm('Remove this connection and its imported snapshot? Revoke access in the provider account separately.')) return; try { await api(`/api/integrations/${connection.provider}/disconnect`,{}); await render(); } catch(error) { notice(error.message); } }; actions.append(disconnect);
      }
      card.append(actions,feedback);
    } else card.append(el('p','Your workspace owner manages these connections.'));
    container.append(card);
  }
  const supplier = el('section',undefined,'record');
  supplier.append(el('h2','Bambu Lab PRM & USA'),el('p','API access pending'),el('p','Supplier syncing and automated ordering are waiting on approved API access. Last confirmed October 6, 2026.'));
  const supplierLinks=el('div',undefined,'actions');
  for(const [label,url] of [['Open PRM portal','https://prm.bambulab.com/#/index'],['Open USA account','https://us.store.bambulab.com/account']]){const link=el('a',label,'authorization-link');link.href=url;link.target='_blank';link.rel='noopener noreferrer';supplierLinks.append(link);}
  supplier.append(supplierLinks);container.append(supplier);
  const imported = await api('/api/integrations/records');
  if (imported.length) container.append(el('h2','Imported account records'));
  for (const record of imported) {
    const card = el('article',undefined,'record'), b = record.body;
    card.append(el('h2',b.title),el('div',`${record.provider} · ${record.type} · Read-only snapshot`,'meta'));
    if (b.contact) card.append(el('p',b.contact));
    if (b.notes) card.append(el('p',b.notes,'notes'));
    if (b.amount) card.append(el('p',`${b.currency} ${b.amount} · ${b.financialStatus} · ${b.fulfillmentStatus}`));
    if (b.status) card.append(el('p',`${b.status}${b.vendor ? ` · ${b.vendor}` : ''}`));
    container.append(card);
  }
}
$('#join-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form)), button = form.querySelector('button');
  if (values.password !== values.confirmPassword) { $('#join-status').textContent = 'Passwords do not match.'; return; }
  button.disabled = true;
  try { await api('/api/invites/accept',{...values,token:inviteToken}); inviteToken = null; form.reset(); $('#join').hidden = true; history.replaceState(null,'','/'); showLogin(); $('#login-form button').disabled = false; $('#connection-status').hidden = true; notice('Account created. Sign in with your new username and password.'); }
  catch(error) { $('#join-status').textContent = error.message; } finally { button.disabled = false; }
};
async function initialize() {
  if (inviteToken) { $('#login').hidden = true; $('#join').hidden = false; return; }
  try {
    const user = await api('/api/me');
    $('#connection-status').hidden = true;
    $('#login-form button').disabled = false;
    await start(user);
  } catch (error) {
    showLogin();
    if (error.message === 'Sign in required') {
      $('#connection-status').hidden = true;
      $('#login-form button').disabled = false;
    } else {
      $('#connection-status').hidden = false;
      $('#connection-status').textContent = 'Unable to connect to the app server. This page needs the running application server; a file or static preview cannot connect. Reload after the server is available.';
    }
  }
}
initialize();

async function renderProposals(container) {
  container.append(el('p','Every action requires your approval. Approving saves the exact contents. Sending is a separate action requiring a configured Gmail sending connection; simulation sends nothing.'));
  if (currentUser.role !== 'owner') { container.append(el('p','The workspace owner reviews proposed external actions.')); return; }
  const data = await api('/api/proposals'), learning = await api('/api/proposals/learning');
  const summary = el('section',undefined,'record');
  summary.append(el('h2','Your review history'),el('p',`${learning.examples.length} approved examples retained (up to 50 shown). Approved corrections are reused for identical draft text, with recipients preserved. Automatic execution is off; no AI model is trained.`));
  container.append(summary);
  if (!data.proposals.length) container.append(el('p','Prepare an action from an email draft or product draft to begin. Email drafts need a recipient address, title, and content; product drafts need a title and description.'));
  for (const proposal of data.proposals) {
    const card = el('article',undefined,'record'), form = el('form');
    card.append(el('h2',`${proposal.kind === 'gmail_send' ? 'Email' : 'Product publication'} proposal #${proposal.id}`),el('p',`Source record #${proposal.record_id} · ${proposal.status} · Revision ${proposal.version}`));
    if (JSON.stringify(proposal.original) !== JSON.stringify(proposal.body)) {
      const details = el('details'), summary = el('summary','Compare with original draft'); details.append(summary);
      for (const [key,value] of Object.entries(proposal.original)) details.append(el('p',`${key}: ${value}`,'notes'));
      card.append(details);
    }
    const editable = ['pending','approved'].includes(proposal.status);
    for (const [key,value] of Object.entries(proposal.body)) {
      const label = el('label',({to:'Recipient',subject:'Subject',content:'Email content',title:'Product title',description:'Product description'})[key]);
      const input = el(['content','description'].includes(key) ? 'textarea' : 'input'); input.name = key; input.value = value; input.required = true; input.readOnly = !editable;
      input.maxLength = key === 'to' ? 254 : ['subject','title'].includes(key) ? 160 : 10000;
      if (key === 'to') input.type = 'email';
      label.append(input); form.append(label);
    }
    const feedbackLabel = el('label','Feedback / reason (optional)'), feedback = el('textarea'); feedback.name = 'note'; feedback.maxLength = 2000; feedback.readOnly = !editable; feedbackLabel.append(feedback); form.append(feedbackLabel);
    const controls = el('div',undefined,'actions');
    if (editable) { const save = el('button','Save changes for review','quiet'); save.type = 'submit'; controls.append(save); }
    const perform = async action => {
      const values = Object.fromEntries(new FormData(form)), {note,...payload} = values;
      if (action !== 'edit' && JSON.stringify(payload) !== JSON.stringify(proposal.body)) return notice('Save your changes before approving or simulating.');
      controls.querySelectorAll('button').forEach(button => button.disabled = true);
      try { await api(`/api/proposals/${proposal.id}/${action}`,{version:proposal.version,payload,note}); await render(); notice(action === 'simulate' ? 'Simulation completed. No external action occurred.' : action==='execute'?'Approved email sent.':action==='reconcile'?'Verified the send in Gmail.':'Review decision saved.'); }
      catch(error) { notice(error.message); await render().catch(()=>{}); }
    };
    form.onsubmit = event => { event.preventDefault(); perform('edit'); };
    if (proposal.status === 'pending') for (const [label,action] of [['Approve exact contents','approve'],['Reject proposal','reject']]) { const button = el('button',label,'quiet'); button.type = 'button'; button.onclick = () => perform(action); controls.append(button); }
    if (proposal.status === 'approved') { const button = el('button','Simulate approved action'); button.type = 'button'; button.onclick = () => perform('simulate'); controls.append(button); }
    if(proposal.kind==='gmail_send'&&['approved','unknown'].includes(proposal.status)){const send=el('button',proposal.status==='unknown'?'Check uncertain send (no resend)':'Send approved email');send.type='button';send.disabled=proposal.status==='approved'&&!data.gmailSendEnabled;if(send.disabled)send.title='Gmail sending permission is not enabled yet';send.onclick=()=>perform(proposal.status==='unknown'?'reconcile':'execute');controls.append(send);}
    form.append(controls); card.append(form); container.append(card);
  }
}

let selectedOpsOrder = null;
const opsRates = new Map(), opsRateWarnings=new Map(),opsShippingDrafts=new Map();
function opsField(label, name, value='', type='text') {
  const wrapper=el('label',label),input=el(type==='textarea'?'textarea':'input'); input.name=name; input.value=value;
  if (type!=='textarea') input.type=type;
  if(type==='number'){input.min='0.001';input.max='1000';input.step='any';}
  input.required=true; wrapper.append(input); return wrapper;
}
function opsForm(fields,label,handler) {
  const form=el('form',undefined,'ops-form'),button=el('button',label);
  form.append(...fields,button);
  form.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{await handler(Object.fromEntries(new FormData(form)));await refresh();}catch(error){notice(error.message);button.disabled=false;}};
  return form;
}
async function renderOrderDesk(container) {
  const response=await api('/api/ops/orders'), orders=response.orders;
  const intro=el('section',undefined,'record'), importButton=el('button','Update desk from imported Shopify snapshot','quiet');
  intro.append(el('h2','Orders, correspondence, packing, and shipping'),el('p',response.execution==='live'?'Live shipping: verify packed weight, dimensions, addresses, and the selected rate. Booking requires owner approval and verified item scans.':'Shipping rates, booking, and tracking below are simulations. No real label is purchased, Shopify is not marked fulfilled, and no customer notification is sent.'),importButton);
  importButton.onclick=async()=>{importButton.disabled=true;try{const result=await api('/api/ops/import',{});await refresh();notice(`Updated ${result.count} order snapshots.`);}catch(error){notice(error.message);importButton.disabled=false;}};
  container.append(intro);
  if (!orders.length) {container.append(el('p','No orders in the desk yet. Update the desk after importing Shopify orders.'));return;}
  const navigation=el('div',undefined,'actions');
  for(const order of orders) {const button=el('button',`${order.body.title} · ${order.store}`,'quiet');button.onclick=()=>{selectedOpsOrder=order.id;render().catch(error=>notice(error.message));};navigation.append(button);}
  container.append(navigation);
  const order=orders.find(order=>order.id===selectedOpsOrder) ?? orders[0];selectedOpsOrder=order.id;
  const card=el('section',undefined,'record');card.append(el('h2',`${order.body.title} · ${order.store}`),el('p',`Shopify reference: ${order.external_id}`));
  if(order.body.amount)card.append(el('p',`${order.body.currency} ${order.body.amount} · ${order.body.financialStatus} · ${order.body.fulfillmentStatus}`));
  if(order.invoice) {const invoiceLink=el('a',`Download invoice draft #${order.invoice.recordId}`,'authorization-link');invoiceLink.href=`/api/records/${order.invoice.recordId}/pdf`;card.append(invoiceLink);if(order.invoice.needsReview)card.append(el('p','Order changed after this invoice draft was prepared. Review the invoice amounts before issuing.'));}
  else card.append(el('p','An invoice draft is prepared automatically for a paid order once its complete line-item, shipping, tax, and total amounts agree.'));
  card.append(el('h2','Packing accuracy'));
  if(!(order.body.items ?? []).length)card.append(el('p','Order line items are not available. Packing and shipping remain blocked until complete Shopify line-item data is imported.'));
  for(const item of order.expectedItems ?? [])card.append(el('p',`${item.sku} · ${item.title ?? ''}: ${order.scans.find(scan=>scan.sku===item.sku)?.scanned ?? 0} / ${item.quantity} scanned`));
  card.append(el('p',order.packed?'All required items verified.':'Waiting for item scans.'));
  if(!order.shipments.length)card.append(opsForm([opsField('Scan SKU or barcode','sku')],'Record item scan',async data=>{const result=await api(`/api/ops/orders/${order.id}/scan`,{...data,scanId:crypto.randomUUID()});notice(`Scanned ${result.scanned} / ${result.expected} of ${result.sku}`);}));
  card.append(el('h2',response.execution==='live'?'Compare shipping rates':'Compare shipping rates (sample providers)'));
  const shippingDraft=opsShippingDrafts.get(order.id)??{savedPackageId:'',kg:'2',length:'30',width:'20',height:'15'};
  const packages=(await api('/api/packages')).filter(item=>!item.archived),packageLabel=el('label','Saved package'),packageSelect=el('select');packageSelect.name='savedPackageId';const custom=el('option','Custom package');custom.value='';packageSelect.append(custom);
  for(const pkg of packages){const option=el('option',pkg.name);option.value=pkg.id;packageSelect.append(option);}packageSelect.value=shippingDraft.savedPackageId;packageLabel.append(packageSelect);
  const shippingForm=opsForm([packageLabel,opsField('Packed weight (kg)','kg',shippingDraft.kg,'number'),opsField('Length (cm)','length',shippingDraft.length,'number'),opsField('Width (cm)','width',shippingDraft.width,'number'),opsField('Height (cm)','height',shippingDraft.height,'number')],response.execution==='live'?'Compare shipping rates':'Compare sample rates',async data=>{opsShippingDrafts.set(order.id,data);const result=await api(`/api/ops/orders/${order.id}/rates`,data);opsRates.set(order.id,result.rates);opsRateWarnings.set(order.id,result.errors ?? []);});
  const changedPackage=()=>{opsShippingDrafts.set(order.id,Object.fromEntries(new FormData(shippingForm)));opsRates.delete(order.id);opsRateWarnings.delete(order.id);card.querySelectorAll('[data-booking]').forEach(button=>button.disabled=true);};
  shippingForm.addEventListener('input',changedPackage);
  packageSelect.onchange=()=>{const pkg=packages.find(item=>String(item.id)===packageSelect.value);if(!pkg)return;for(const [key,value] of Object.entries({kg:pkg.body.kg,...pkg.body.cm}))shippingForm.elements[key].value=value===null?'':Number(value.toFixed(5));changedPackage();};
  card.append(shippingForm);
  for(const warning of opsRateWarnings.get(order.id) ?? [])card.append(el('p',`${warning.provider}: ${warning.message}. Comparison is incomplete.`));
  for(const rate of opsRates.get(order.id) ?? []) {
    const line=el('div',undefined,'rate-option');line.append(el('span',`${rate.provider} · ${rate.service} · ${money(rate.priceCents,rate.currency)} · ${rate.days} days · ${rate.package?.name ?? 'Custom package'} · ${rate.environment==='sandbox'?'sandbox API estimate':rate.simulated?'sample estimate':'provider estimate'}`));
    if(currentUser.role==='owner' && !order.shipments.length){const book=el('button',(rate.simulated||rate.environment==='sandbox')?'Approve & simulate booking':'Approve booking & Shopify tracking');book.dataset.booking='true';book.disabled=!order.packed;book.onclick=async()=>{book.disabled=true;try{await api(`/api/ops/orders/${order.id}/book`,{rateId:rate.id,approve:true});await render();notice(rate.simulated?'Simulation saved. No shipment was purchased.':'Shipment booking result saved. Check Shopify tracking status in Shipping setup & jobs.');}catch(error){notice(error.message);book.disabled=false;}};line.append(book);}
    card.append(line);
  }
  for(const shipment of order.shipments){card.append(el('p',`${shipment.status==='simulated'?'SIMULATED tracking':'Tracking'}: ${shipment.tracking} · ${shipment.provider} · ${money(shipment.price_cents,shipment.currency)} · Shopify: ${shipment.fulfillment_status || 'not synced'}`));
    for(const [label,value] of [['View label',shipment.label_url],['Track shipment',shipment.tracking_url]])if(value){try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)continue;const link=el('a',label,'authorization-link');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}catch{}}
  }
  card.append(el('h2','Order notes & linked email'));
  const suggestions=(currentUser.role==='owner'?await api('/api/ops/email-suggestions'):[]).filter(item=>item.orderId===order.id);
  for(const suggestion of suggestions){const candidate=el('div',undefined,'rate-option');candidate.append(el('span',`${suggestion.email.title}: ${suggestion.reason}`));
    for(const [label,reject] of [['Link to order',false],['Reject suggested link',true]]){const button=el('button',label,'quiet');button.onclick=async()=>{button.disabled=true;try{await api(`/api/ops/orders/${order.id}/email`,{emailId:suggestion.emailId,reject});await render();}catch(error){notice(error.message);button.disabled=false;}};candidate.append(button);}card.append(candidate);}

  for(const note of order.notes)card.append(el('p',`${note.username} · ${note.kind} · ${new Date(note.created_at).toLocaleString()}
${note.content}`,'notes'));
  card.append(opsForm([opsField('Add internal order note','content','','textarea')],'Save order note',data=>api(`/api/ops/orders/${order.id}/note`,data)));
  const imported=await api('/api/integrations/records'), emails=imported.filter(record=>record.provider==='gmail'&&record.type==='message');
  if(emails.length && currentUser.role==='owner') {
    const label=el('label','Select email to attach to order notes'),select=el('select');select.name='emailId';
    for(const email of emails){const option=el('option',`${email.body.title} · ${email.body.contact}`);option.value=email.external_id;select.append(option);}label.append(select);
    card.append(opsForm([label],'Link selected email',data=>api(`/api/ops/orders/${order.id}/email`,data)));
  }
  card.append(el('h2','Support / warranty claim'));
  const category=el('label','Category'),select=el('select');select.name='category';
  for(const value of ['warranty','support','return','shipping']){const option=el('option',value);option.value=value;select.append(option);}category.append(select);
  card.append(opsForm([category,opsField('Ticket title','title'),opsField('Claim / support details','details','','textarea')],'Open ticket',data=>api(`/api/ops/orders/${order.id}/ticket`,data)));
  for(const ticket of order.tickets)card.append(el('p',`Ticket #${ticket.id}: ${ticket.title} · ${ticket.status}`));
  container.append(card);
}
async function renderTickets(container) {
  if(currentUser.role==='owner'){
    const intakes=await api('/api/support/intakes'),orders=(await api('/api/ops/orders')).orders;
    container.append(el('h2','Requests awaiting review'),el('p','Customer-submitted details and email previews need identity and order verification before sharing with staff or taking external action.'));
    const supportLink=el('a','Open customer support form','authorization-link');supportLink.href='/support';supportLink.target='_blank';supportLink.rel='noopener';container.append(supportLink);
    for(const intake of intakes.filter(item=>item.status==='pending')){const card=el('section',undefined,'record');card.append(el('h2',intake.subject),el('p',`${intake.source} · ${intake.email} · ${intake.category} · Order reference: ${intake.order_reference||'not provided'} · Serial: ${intake.serial_number||'not provided'}`),el('p',intake.details,'notes'));
      const label=el('label','Verified customer order'),select=el('select');select.name='orderId';const blank=el('option','Choose an order');blank.value='';select.append(blank);select.required=true;
      for(const order of orders){const option=el('option',`${order.body.title} · ${order.store}`);option.value=order.id;select.append(option);}label.append(select);card.append(opsForm([label],'Create linked support ticket',values=>api(`/api/support/intakes/${intake.id}/convert`,{orderId:Number(values.orderId),version:intake.version})));
      const dismiss=el('button','Dismiss request','quiet');dismiss.onclick=async()=>{dismiss.disabled=true;try{await api(`/api/support/intakes/${intake.id}/dismiss`,{version:intake.version});await render();}catch(error){notice(error.message);dismiss.disabled=false;}};card.append(dismiss);container.append(card);}
  }
  const tickets=await api('/api/ops/tickets');
  if(!tickets.length)container.append(el('p','Open a warranty, support, return, or shipping ticket from an order in Order desk.'));
  for(const ticket of tickets){
    const card=el('section',undefined,'record');card.append(el('h2',`#${ticket.id} · ${ticket.title}`),el('p',`${ticket.category} · Order desk #${ticket.order_id} · ${ticket.status}`),el('p',ticket.details,'notes'));
    const label=el('label','Status'),select=el('select');select.name='status';
    for(const value of ['open','in_progress','waiting_customer','waiting_supplier','resolved']){const option=el('option',readable(value));option.value=value;select.append(option);}select.value=ticket.status;label.append(select);
    const assignee=opsField('Assigned teammate (optional)','assignee',ticket.assignee);assignee.querySelector('input').required=false;
    card.append(opsForm([label,assignee,opsField('Update / resolution note','note','','textarea')],'Save ticket update',data=>api(`/api/ops/tickets/${ticket.id}`,{...data,version:ticket.version})));
    const open=el('button','Open linked order','quiet');open.onclick=()=>{selectedOpsOrder=ticket.order_id;area='orderdesk';render().catch(error=>notice(error.message));};card.append(open);container.append(card);
  }
}

function supplierForm(handler,value={},sourceOrders=[]) {
  const form=el('form'),fields=el('div',undefined,'form-grid');
  const choice=(label,name,options,selected)=>{const wrapper=el('label',label),select=el('select');select.name=name;for(const [text,value]of options){const option=el('option',text);option.value=value;select.append(option);}select.value=selected;wrapper.append(select);return wrapper;};
  const supplier=choice('Supplier account','supplier',[['Bambu PRM','prm'],['Bambu USA','usa']],value.supplier??'prm');
  const currency=choice('Currency','currency',[['CAD','CAD'],['USD','USD']],value.currency??'CAD');
  const sample=el('label','Fictional sample order'),sampleCheckbox=el('input');sampleCheckbox.type='checkbox';sampleCheckbox.name='sampleData';sampleCheckbox.checked=value.sampleData??false;sample.append(sampleCheckbox);
  const date=opsField('Expected arrival (optional)','expectedDate',value.expectedDate??'','date');date.querySelector('input').required=false;
  fields.append(opsField('Purchase order title','purchaseTitle',value.title??''),supplier,currency,date,sample);
  const source=choice('USA customer order (optional)','sourceOrderId',[['Warehouse inbound / no customer order',''],...sourceOrders.map(order=>[`${order.body.title} · ${order.store}`,String(order.id)])],'');fields.append(source);
  const rows=el('div'),add=el('button','Add purchase line','quiet');add.type='button';
  const addRow=(item={})=>{const line=el('fieldset');line.append(el('legend','Purchase line'));for(const [label,name,type,defaultValue]of [['Our SKU','sku','text',''],['Supplier SKU','supplierSku','text',''],['Item description','title','text',''],['Barcode (optional)','barcode','text',''],['Units','quantity','number',1],['Unit cost','unitCost','number','0.00']]){const field=opsField(label,name,item[name]??(name==='unitCost'&&item.unitCostCents!==undefined?(item.unitCostCents/100).toFixed(2):defaultValue),type);if(name==='barcode')field.querySelector('input').required=false;if(type==='number'){field.querySelector('input').min=name==='quantity'?'1':'0';field.querySelector('input').step=name==='quantity'?'1':'0.01';}line.append(field);}const remove=el('button','Remove line','quiet');remove.type='button';remove.onclick=()=>line.remove();line.append(remove);rows.append(line);};
  for(const item of value.items??[{}])addRow(item);add.onclick=()=>addRow();
  source.querySelector('select').onchange=()=>{const order=sourceOrders.find(item=>String(item.id)===source.querySelector('select').value);if(!order)return;supplier.querySelector('select').value='usa';currency.querySelector('select').value=order.body.currency??'USD';sampleCheckbox.checked=order.body.sampleData===true;rows.replaceChildren();for(const item of order.body.items??[])addRow({...item,supplierSku:'',unitCostCents:0});};
  const notes=opsField('Purchasing / supplier notes (optional)','notes',value.notes??'','textarea');notes.querySelector('textarea').required=false;
  const submit=el('button','Save purchase draft');form.append(fields,rows,add,notes,submit);
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{const data=Object.fromEntries(new FormData(form));data.title=data.purchaseTitle;data.sampleData=sampleCheckbox.checked;data.items=[...rows.querySelectorAll('fieldset')].map(row=>{const get=name=>row.querySelector(`[name="${name}"]`).value,cost=get('unitCost');if(!/^\d+(\.\d{1,2})?$/.test(cost))throw new Error('Unit cost must have at most two decimal places');const [whole,fraction='']=cost.split('.');return {sku:get('sku'),supplierSku:get('supplierSku'),title:get('title'),barcode:get('barcode'),quantity:Number(get('quantity')),unitCostCents:Number(whole)*100+Number(fraction.padEnd(2,'0'))};});await handler(data);await render();notice('Supplier purchase draft saved.');}catch(error){notice(error.message);submit.disabled=false;}};
  return form;
}
async function renderSuppliers(container) {
  const data=await api('/api/supplier-orders'),orders=(await api('/api/ops/orders')).orders;
  container.append(el('h2','Bambu purchasing and inbound receiving'),el('p','API access pending. Prepare supplier-mapped purchase drafts for review now. Fictional orders can be simulated and received by scanning; live supplier submission, inventory writes, and fulfillment remain unavailable.'));
  const create=el('details'),summary=el('summary','Prepare a purchase order');create.append(summary,supplierForm(values=>api('/api/supplier-orders',values),{},orders.filter(order=>order.store==='blckcompany.myshopify.com'||order.body.sampleData===true)));container.append(create);
  if(!data.orders.length)container.append(el('p','No purchase requests yet.'));
  for(const order of data.orders){const card=el('section',undefined,'record'),b=order.body;
    card.append(el('h2',`#${order.id} · ${b.title}`),el('p',`${order.supplier==='prm'?'Bambu PRM':'Bambu USA'} · ${readable(order.status)} · ${b.sampleData?'Fictional sample':'Supplier submission pending'} · ${money(b.totalCents,b.currency)}`));
    if(b.expectedDate)card.append(el('p',`Expected arrival: ${b.expectedDate}`));if(b.customerOrder)card.append(el('p',`Customer order: ${b.customerOrder.snapshot.title} · ${b.customerOrder.store}`));
    const table=el('table'),header=el('tr');for(const label of ['Our SKU / supplier SKU','Units','Unit cost','Good / damaged / missing'])header.append(el('th',label));table.append(header);
    for(const item of b.items){const receipts=order.receipts.filter(row=>row.sku===item.sku),good=receipts.filter(row=>row.condition==='good').length,damaged=receipts.length-good,row=el('tr');for(const value of [`${item.sku} / ${item.supplierSku}`,item.quantity,money(item.unitCostCents,b.currency),`${good} / ${damaged} / ${item.quantity-receipts.length}`])row.append(el('td',String(value)));table.append(row);}card.append(table);if(b.notes)card.append(el('p',b.notes,'notes'));
    const actions=el('div',undefined,'actions');
    const button=(label,action)=>{const control=el('button',label,'quiet');control.onclick=async()=>{control.disabled=true;try{await api(`/api/supplier-orders/${order.id}/${action}`,{version:order.version});await render();notice(action==='simulate'?'Fictional inbound simulated.':'Supplier review saved; nothing submitted to Bambu.');}catch(error){notice(error.message);control.disabled=false;}};actions.append(control);};
    if(['draft','rejected'].includes(order.status))button('Submit for review','submit');
    if(currentUser.role==='owner'&&order.status==='review'){button('Approve purchase draft','approve');button('Reject draft','reject');}
    if(currentUser.role==='owner'&&order.status==='approved'){if(b.sampleData)button('Simulate supplier acceptance','simulate');else card.append(el('p','Approved and awaiting Bambu API access.'));button('Revoke approval','reject');}
    if(['draft','review','approved','rejected'].includes(order.status)&&!order.source_order_id){const edit=el('details');edit.append(el('summary','Edit draft (revokes approval)'),supplierForm(values=>api(`/api/supplier-orders/${order.id}/edit`,{version:order.version,payload:values}),{...b,supplier:order.supplier}));actions.append(edit);}card.append(actions);
    if(b.sampleData&&order.status==='simulated'){
      const serial=opsField('Serial number (optional)','serialNumber'),note=opsField('Damage / receiving note (optional)','note','','textarea');serial.querySelector('input').required=false;note.querySelector('textarea').required=false;
      const condition=el('label','Item condition'),select=el('select');select.name='condition';for(const value of ['good','damaged']){const option=el('option',readable(value));option.value=value;select.append(option);}condition.append(select);
      card.append(opsForm([opsField('Scan inbound SKU or barcode','code'),serial,condition,note],'Receive one sample unit',values=>api(`/api/supplier-orders/${order.id}/receive`,{...values,scanId:crypto.randomUUID()})));
    }
    for(const receipt of order.receipts)card.append(el('p',`${receipt.username} · ${receipt.sku} · ${receipt.condition} · ${receipt.serial_number??'no serial'} · ${receipt.note}`,'meta'));
    const history=el('details');history.append(el('summary','Purchase review history'));for(const entry of order.history)history.append(el('p',`Revision ${entry.version} · ${entry.action} · ${readable(entry.status)} · ${entry.body.title} · ${money(entry.body.totalCents,entry.body.currency)} · ${new Date(entry.at).toLocaleString()}`));card.append(history);
    container.append(card);
  }
}

function packageFields(value={}) {
  const units=el('label','Dimension unit'),select=el('select');select.name='dimensionUnit';for(const name of ['cm','in']){const option=el('option',name);option.value=name;select.append(option);}select.value=value.dimensionUnit ?? 'cm';units.append(select);
  const weights=el('label','Weight unit'),weightSelect=el('select');weightSelect.name='weightUnit';for(const name of ['kg','lb']){const option=el('option',name);option.value=name;weightSelect.append(option);}weightSelect.value=value.weightUnit ?? 'kg';weights.append(weightSelect);
  const fields=[opsField('Package name','name',value.name ?? ''),units,opsField('Length','length',value.length ?? '', 'number'),opsField('Width','width',value.width ?? '', 'number'),opsField('Height','height',value.height ?? '', 'number'),weights,opsField('Default packed weight (optional)','weight',value.weight ?? '', 'number')];fields.find(field=>field.querySelector('[name="weight"]'))?.querySelector('input').removeAttribute('required');return fields;
}
async function renderPackages(container) {
  const packages=await api('/api/packages');container.append(el('p','Save the boxes and package sizes you ship regularly. Selecting one fills the dimensions and default packed weight; verify the actual packed weight before requesting rates.'));
  if(currentUser.role==='owner'){const create=el('section',undefined,'record');create.append(el('h2','Save a package'),opsForm(packageFields(),'Save package',values=>api('/api/packages',values)));container.append(create);}
  for(const pkg of packages){const card=el('section',undefined,'record');card.append(el('h2',`${pkg.name}${pkg.archived?' (archived)':''}`),el('p',`${pkg.body.length} × ${pkg.body.width} × ${pkg.body.height} ${pkg.body.dimensionUnit} · ${pkg.body.weight===null?'Enter packed weight when shipping':`${pkg.body.weight} ${pkg.body.weightUnit}`} · Revision ${pkg.version}`));
    if(currentUser.role==='owner'){if(!pkg.archived)card.append(opsForm(packageFields(pkg.body),'Save package changes',payload=>api(`/api/packages/${pkg.id}`,{payload,version:pkg.version})));
      const archive=el('button',pkg.archived?'Restore package':'Archive package','quiet');archive.onclick=async()=>{archive.disabled=true;try{await api(`/api/packages/${pkg.id}`,{version:pkg.version,archived:!pkg.archived});await render();}catch(error){notice(error.message);archive.disabled=false;}};card.append(archive);}
    container.append(card);
  }
}

async function renderShipping(container) {
  if(currentUser.role!=='owner'){container.append(el('p','The workspace owner configures shipping and reviews provider reconciliation.'));return;}
  const data=await api('/api/shipping/settings'),monitor=await api('/api/sync/status');
  container.append(el('p',`Shipping mode: ${data.mode} · Comparison currency: ${data.comparisonCurrency}. Automatic read-only sync: ${monitor.enabled?`every ${monitor.intervalSeconds} seconds`:'not enabled'}.`));
  for(const provider of data.providers)container.append(el('p',`${provider.provider}: ${provider.configured?'API credential configured':'API access required'}${provider.provider==='freightcom'?provider.bookingConfigured?' · Payment method configured':' · Payment method required for booking':''}`));
  const setup=el('section',undefined,'record');setup.append(el('h2','Shipping origin by store'),el('p','Use the warehouse assigned to these Shopify fulfillment orders. Sender details are required for live rate requests.'));
  const originForm=opsForm([opsField('Shopify store identity','store'),opsField('Warehouse / contact name','name'),opsField('Sender company name','companyName'),opsField('Shopify fulfillment location ID','locationId'),opsField('Street address','address1'),opsField('Address line 2 (optional)','address2'),opsField('City','city'),opsField('Province/state code','provinceCode'),opsField('Country code (CA or US)','countryCodeV2','CA'),opsField('Postal/ZIP code','zip'),opsField('Phone','phone'),opsField('Shipping contact email','email','','email')],'Save shipping origin',async values=>{const {store,...address}=values;await api('/api/shipping/origin',{store,address});});originForm.querySelector('[name="address2"]').required=false;
  const connections=await api('/api/integrations');for(const connection of connections.filter(item=>item.provider!=='gmail'&&item.connected)){
    const load=el('button',`Load ${connection.provider==='shopify_usa'?'USA':'Canada'} warehouses from Shopify`,'quiet'),locations=el('div');load.disabled=!connection.locationsEnabled;load.title=load.disabled?'Reconnect with approved warehouse-reading permissions':'';
    load.onclick=async()=>{load.disabled=true;try{const rows=await api(`/api/integrations/${connection.provider}/locations`);locations.replaceChildren();if(!rows.length)locations.append(el('p','No active online-fulfillment warehouses were returned.'));for(const location of rows){const choose=el('button',`${location.name} · ${location.address.city??''} ${location.address.countryCodeV2??''}`,'quiet');choose.onclick=()=>{for(const [key,value]of Object.entries({...location.address,store:location.store,name:location.name,locationId:location.id})){const field=originForm.querySelector(`[name="${key}"]`);if(field)field.value=value??'';}notice('Warehouse address filled. Verify sender company and contact before saving.');};locations.append(choose);}}catch(error){notice(error.message);}finally{load.disabled=false;}};setup.append(load,locations);
  }setup.append(originForm);container.append(setup);
  for(const origin of data.origins)container.append(el('p',`${origin.store}: ${origin.body.name} · ${origin.body.city}, ${origin.body.provinceCode} ${origin.body.countryCodeV2}`));
  const classification=el('section',undefined,'record');classification.append(el('h2','Saved SKU shipping profiles'),el('p','Use the product classification and origin supplied by your manufacturer or customs adviser. The desk does not guess these declarations.'));
  const battery=el('label','Battery declaration'),batterySelect=el('select');batterySelect.name='battery';batterySelect.required=true;for(const value of ['','none','in_equipment','packed_with_equipment']){const option=el('option',value?readable(value):'Choose battery declaration');option.value=value;batterySelect.append(option);}battery.append(batterySelect);
  const goods=el('label','Dangerous goods'),goodsSelect=el('select');goodsSelect.name='dangerousGoods';goodsSelect.required=true;for(const value of ['','false','true']){const option=el('option',value===''?'Choose dangerous-goods declaration':value==='true'?'Yes - requires carrier review':'No');option.value=value;goodsSelect.append(option);}goods.append(goodsSelect);
  const category=el('label','Item category (or use HS code)'),categorySelect=el('select');categorySelect.name='category';
  for(const [value,label]of [['','Choose a category or enter an HS code'],['accessory_no_battery','Accessory (no battery)'],['home_appliances','Home appliances'],['home_decor','Home decor'],['computers_laptops','Computers & laptops'],['cameras','Cameras'],['mobile_phones','Mobile phones'],['tablets','Tablets'],['accessory_with_battery','Accessory (with battery)'],['health_beauty','Health & beauty'],['fashion','Fashion'],['watches','Watches'],['toys','Toys'],['sport_leisure','Sport & leisure'],['bags_luggages','Bags & luggage'],['audio_video','Audio & video'],['documents','Documents'],['jewelry','Jewelry'],['dry_food_supplements','Dry food & supplements'],['books_collectibles','Books & collectibles'],['pet_accessory','Pet accessories']]){const option=el('option',label);option.value=value;categorySelect.append(option);}category.append(categorySelect);
  const productForm=opsForm([opsField('Store identity','store'),opsField('SKU','sku'),category,opsField('Verified HS code (or use category)','hsCode'),opsField('Country of manufacture (optional for domestic)','countryOfOrigin'),battery,goods],'Save product shipping profile',values=>api('/api/shipping/product',{...values,dangerousGoods:values.dangerousGoods==='true'}));
  for(const name of ['category','hsCode','countryOfOrigin'])productForm.querySelector(`[name="${name}"]`).required=false;
  const imported=(await api('/api/ops/orders')).orders,seen=new Set();for(const order of imported)for(const item of order.body.items??[]){const key=`${order.store}:${item.sku}`;if(seen.has(key)||data.products.some(profile=>profile.store===order.store&&profile.sku===item.sku))continue;seen.add(key);const choose=el('button',`Review ${item.sku||'missing SKU'} · ${order.store}`,'quiet');choose.onclick=()=>{for(const [key,value]of Object.entries({store:order.store,sku:item.sku,hsCode:item.hsCode,countryOfOrigin:item.countryOfOrigin,category:''})){productForm.querySelector(`[name="${key}"]`).value=value??'';}batterySelect.value='';goodsSelect.value='';notice('Shopify classification filled when available. Confirm missing values and battery/dangerous-goods declarations.');};classification.append(choose);}
  classification.append(productForm);for(const product of data.products)classification.append(el('p',`${product.store} · ${product.sku} · HS ${product.body.hsCode??'not supplied'} · ${product.body.category??''} · ${product.body.countryOfOrigin??'origin not supplied'}`));container.append(classification);
  container.append(el('h2','Booking and tracking jobs'));
  if(!data.jobs.length)container.append(el('p','Jobs appear after a shipment is approved. A request with an unknown outcome must be reconciled with the provider before rebooking.'));
  for(const job of data.jobs){const card=el('section',undefined,'record');card.append(el('h2',`Job #${job.id} · Order desk #${job.order_id}`),el('p',`${job.status}${job.external_id?` · Provider shipment ${job.external_id}`:''}`));if(job.error)card.append(el('p',job.error));
    if(job.external_id)for(const [label,action] of [['Retrieve provider status','reconcile'],['Retry Shopify tracking update','retry-tracking'],['Cancel verified unpaid draft','cancel-unpaid']]){const button=el('button',label,'quiet');button.onclick=async()=>{button.disabled=true;try{if(action==='cancel-unpaid'&&!confirm('Remove this unpaid provider draft? It cannot be restored. The server will refuse if a label was purchased.'))return;await api(`/api/shipping/jobs/${job.id}/${action}`,{confirm:action==='cancel-unpaid'});await render();}catch(error){notice(error.message);button.disabled=false;}};card.append(button);}container.append(card);}
  for(const health of monitor.providers)container.append(el('p',`${health.provider}: ${health.status} · ${health.message} · ${new Date(health.checked_at).toLocaleString()}`));
}
