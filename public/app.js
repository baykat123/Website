const $ = selector => document.querySelector(selector);
const areas = [['overview','Overview'],['quote','Quotes'],['order','Orders'],['invoice','Invoices'],['task','Follow-ups & marketing'],['message','Email drafts'],['shipment','Dropship shipments'],['product','Product drafts'],['approvals','Review queue'],['connections','Connections'],['team','Team & account'],['audit','Activity']];
const requestedView = new URLSearchParams(location.search).get('view');
let area = requestedView === 'connections' ? 'connections' : 'overview', records = [], noticeTimer, editing = null, currentUser = null;
let inviteToken = location.pathname === '/join' ? new URLSearchParams(location.search).get('token') : null;
if (inviteToken) history.replaceState(null,'','/join');
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function notice(message) { $('#notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').textContent = '', 6000); }
async function api(path, body) {
  const response = await fetch(path, { signal: AbortSignal.timeout(path.endsWith('/sync') ? 120000 : 10000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
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
  $('#heading').textContent = areas.find(entry => entry[0] === area)[1];
  $('#new-record').hidden = ['audit','connections','team'].includes(area);
  $('.toolbar').hidden = ['audit','connections','team'].includes(area);
  $('#stats').replaceChildren();
  const today = new Date().toLocaleDateString('en-CA');
  const overdue = records.filter(record => record.body.due && record.body.due < today && !['done','paid','fulfilled','delivered'].includes(record.body.status));
  const stats = [['Shared records', records.length], ['Awaiting review', records.filter(record => record.body.status === 'pending_review').length], ['Past due', overdue.length]];
  for (const [label, count] of stats) { const card = el('div',undefined,'stat'); card.append(el('span',label),el('strong',String(count))); $('#stats').append(card); }
  const container = $('#records'); container.replaceChildren();
  if (area === 'team') { await renderTeam(container); return; }
  if (area === 'connections') { await renderConnections(container); return; }
  if (area === 'audit') {
    const events = await api('/api/audit');
    for (const event of events) container.append(el('div',`${event.username}${event.record_id ? ` · #${event.record_id}` : ''} · ${event.action} · ${new Date(event.at).toLocaleString()}`,'audit'));
    if (!events.length) container.append(el('p','Activity will appear after records are created.'));
    return;
  }
  const search = $('#search').value.toLowerCase(), status = $('#filter').value;
  const shown = records.filter(record => (area === 'overview' || area === record.type || area === 'approvals' && record.body.status === 'pending_review') && (!status || record.body.status === status) && [record.body.title,record.body.contact,record.body.notes,record.body.assignee].join(' ').toLowerCase().includes(search));
  if (!shown.length) { const empty = el('div',undefined,'empty'); empty.append(el('h2','No matching records'),el('p','Create a record to begin, or adjust your search.')); container.append(empty); }
  for (const record of shown) {
    const b = record.body, card = el('article',undefined,'record'), head = el('div',undefined,'record-heading'), left = el('div');
    left.append(el('h2',b.title),el('div',[`${record.type} #${record.id}`,b.contact,b.assignee && `Assigned: ${b.assignee}`,b.due && `Due: ${b.due}`].filter(Boolean).join(' · '),'meta'));
    head.append(left,el('span',readable(b.status),`badge${b.status === 'pending_review' ? ' review' : ''}`)); card.append(head);
    if (b.items) {
      const table = el('table'), header = el('tr'); ['Description','Qty','Unit price','Total'].forEach(label => header.append(el('th',label))); table.append(header);
      for (const item of b.items) { const row = el('tr'); [item.description,String(item.quantity),money(item.unitPriceCents,b.currency),money(item.quantity*item.unitPriceCents,b.currency)].forEach(value => row.append(el('td',value))); table.append(row); }
      card.append(table,el('div',`Shipping ${money(b.shippingCents,b.currency)} · Tax ${money(b.taxCents,b.currency)}`,'meta'),el('div',money(b.totalCents,b.currency),'total'));
    }
    if (b.supplier || b.tracking) card.append(el('div',[b.supplier && `Supplier: ${b.supplier}`, b.tracking && `Tracking: ${b.tracking}`].filter(Boolean).join(' · '),'meta'));
    if (b.notes) card.append(el('p',b.notes,'notes'));
    const buttons = el('div',undefined,'actions');
    if (['draft','open','in_progress','ordered','shipped'].includes(b.status)) { const edit = el('button','Edit','quiet'); edit.onclick = () => openEditor(record); buttons.append(edit); }
    const choices = { draft: [['Submit for review','pending_review']], pending_review: [['Approve record','approved'],['Return to draft','draft']], open: record.type === 'task' ? [['Start task','in_progress'],['Complete task','done']] : [['Mark ordered','ordered']], in_progress: [['Complete task','done']], ordered: [['Mark shipped','shipped']], shipped: [['Mark delivered','delivered']], done: [['Reopen','open']], approved: record.type === 'order' ? [['Mark fulfilled','fulfilled']] : record.type === 'invoice' ? [['Mark paid','paid']] : [] };
    for (const [label,target] of choices[b.status] ?? []) { const button = el('button',label,'quiet'); button.onclick = () => action(record,'status',target); buttons.append(button); }
    if (['approved','fulfilled'].includes(b.status) && ['quote','order'].includes(record.type)) { const button = el('button',record.type === 'quote' ? 'Create order draft' : 'Create invoice draft'); button.onclick = () => action(record,'convert'); buttons.append(button); }
    card.append(buttons); container.append(card);
  }
}
for (const [id,label] of areas) { const button = el('button',label,id === area ? 'active' : ''); button.onclick = async () => { area = id; $('#nav').querySelectorAll('button').forEach(node => node.classList.toggle('active',node === button)); $('#filter').value = ''; await render().catch(error => notice(error.message)); }; $('#nav').append(button); }
$('#login-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; try { const user = await api('/api/login',Object.fromEntries(new FormData(form))); form.reset(); await start(user); } catch (error) { notice(error.message); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/api/logout',{}); showLogin(); } catch(error) { notice(error.message); } };
$('#search').oninput = () => render().catch(error => notice(error.message));
$('#filter').onchange = () => render().catch(error => notice(error.message));
$('#refresh').onclick = () => refresh().catch(error => notice(error.message));
function addLine(item = {}) {
  const row = el('div',undefined,'line-item');
  for (const [name,placeholder,value,type] of [['description','Description','','text'],['quantity','Qty','1','number'],['unitPrice','Price','0.00','number']]) { const input = el('input'); input.dataset.field = name; input.placeholder = placeholder; input.setAttribute('aria-label',placeholder); input.value = item[name] ?? value; input.type = type; input.required = true; if (type === 'number') { input.min = name === 'quantity' ? '1' : '0'; input.step = name === 'quantity' ? '1' : '0.01'; } else input.maxLength = 300; row.append(input); }
  const remove = el('button','×','quiet'); remove.type = 'button'; remove.setAttribute('aria-label','Remove line'); remove.onclick = () => row.remove(); row.append(remove); $('#line-items').append(row);
}
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
  updateFields(); $('#editor').showModal();
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
  for (const connection of connections) {
    const card = el('section',undefined,'record'), name = connection.provider === 'gmail' ? 'Google Workspace Gmail' : 'Shopify';
    card.append(el('h2',name),el('p',connection.connected ? `Connected: ${connection.account}` : connection.configured ? 'Ready to connect your account.' : 'Initial provider application setup is still required.'));
    card.append(el('p',connection.provider === 'gmail' ? 'Sync imports up to 25 inbox message subjects, senders, and previews. It does not send messages or monitor continuously.' : 'Sync imports up to 25 recent orders and 25 recently updated products. It does not publish products or place orders.'));
    if (connection.lastSync) card.append(el('div',`Last successful sync: ${new Date(connection.lastSync).toLocaleString()}`,'meta'));
    if (currentUser.role === 'owner') {
      const actions = el('div',undefined,'actions'), connect = el('button',connection.connected ? 'Reconnect' : `Connect ${connection.provider === 'gmail' ? 'Gmail' : 'Shopify'}`);
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
        const sync = el('button','Sync now','quiet'); sync.onclick = async () => { sync.disabled = true; sync.textContent = 'Syncing…'; try { const result = await api(`/api/integrations/${connection.provider}/sync`,{}); await render(); notice(`Imported ${result.count} records.`); } catch(error) { notice(error.message); } finally { sync.disabled = false; sync.textContent = 'Sync now'; } }; actions.append(sync);
        const disconnect = el('button','Disconnect','quiet'); disconnect.onclick = async () => { if (!confirm('Remove this connection and its imported snapshot? Revoke access in the provider account separately.')) return; try { await api(`/api/integrations/${connection.provider}/disconnect`,{}); await render(); } catch(error) { notice(error.message); } }; actions.append(disconnect);
      }
      card.append(actions,feedback);
    } else card.append(el('p','Your workspace owner manages these connections.'));
    container.append(card);
  }
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
