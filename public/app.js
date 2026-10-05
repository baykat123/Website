const $ = selector => document.querySelector(selector);
const areas = [['overview','Overview'],['quote','Quotes'],['order','Orders'],['invoice','Invoices'],['task','Follow-ups & marketing'],['message','Email drafts'],['shipment','Dropship shipments'],['product','Product drafts'],['approvals','Review queue'],['audit','Activity']];
let area = 'overview', records = [], noticeTimer, editing = null;
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function notice(message) { $('#notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').textContent = '', 6000); }
async function api(path, body) {
  const response = await fetch(path, { signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('The app server could not be reached. Open the app through its running server, rather than a file or static preview.');
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/login') showLogin(); throw new Error(data.error ?? 'Request failed'); }
  return data;
}
function showLogin() { records = []; $('#records').replaceChildren(); $('#stats').replaceChildren(); $('#editor').close(); $('#workspace').hidden = true; $('#login').hidden = false; }
async function start(user) { $('#user').textContent = user.username; $('#login').hidden = true; $('#workspace').hidden = false; await refresh(); }
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
  $('#new-record').hidden = area === 'audit';
  $('#stats').replaceChildren();
  const today = new Date().toLocaleDateString('en-CA');
  const overdue = records.filter(record => record.body.due && record.body.due < today && !['done','paid','fulfilled','delivered'].includes(record.body.status));
  const stats = [['Shared records', records.length], ['Awaiting review', records.filter(record => record.body.status === 'pending_review').length], ['Past due', overdue.length]];
  for (const [label, count] of stats) { const card = el('div',undefined,'stat'); card.append(el('span',label),el('strong',String(count))); $('#stats').append(card); }
  const container = $('#records'); container.replaceChildren();
  if (area === 'audit') {
    const events = await api('/api/audit');
    for (const event of events) container.append(el('div',`${event.username} · #${event.record_id} · ${event.action} · ${new Date(event.at).toLocaleString()}`,'audit'));
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
async function initialize() {
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
