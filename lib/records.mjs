export const types = ['quote', 'order', 'invoice', 'task', 'product', 'message', 'shipment'];
const statuses = {
  quote: ['draft', 'pending_review', 'approved'], order: ['draft', 'pending_review', 'approved', 'fulfilled'],
  invoice: ['draft', 'pending_review', 'approved', 'paid'], task: ['open', 'in_progress', 'done'],
  product: ['draft', 'pending_review', 'approved'], message: ['draft', 'pending_review', 'approved'],
  shipment: ['open', 'ordered', 'shipped', 'delivered']
};
const text = (value, max = 2000) => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`Text must be at most ${max} characters`);
  return value.trim();
};
export function cents(value) {
  const s = String(value ?? '0');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) throw new Error('Amounts must be non-negative with at most two decimal places');
  const [whole, fraction = ''] = s.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function validateRecord(type, input) {
  if (!types.includes(type)) throw new Error('Unknown record type');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Record must be an object');
  const status = input.status ?? statuses[type][0];
  if (!statuses[type].includes(status)) throw new Error('Invalid status');
  const title = text(input.title, 160);
  if (!title) throw new Error('A title is required');
  const due = text(input.due, 10);
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) throw new Error('Invalid due date');
  const result = { title, status, contact: text(input.contact, 160), assignee: text(input.assignee, 80), notes: text(input.notes, 10000), due, currency: text(input.currency ?? 'USD', 3), supplier: text(input.supplier, 160), tracking: text(input.tracking, 160) };
  if (!/^[A-Z]{3}$/.test(result.currency)) throw new Error('Use a three-letter currency code');
  if (['quote', 'order', 'invoice'].includes(type)) {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new Error('Add between 1 and 100 line items');
    result.items = input.items.map(item => {
      const description = text(item.description, 300);
      const quantity = Number(item.quantity);
      if (!description || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw new Error('Each item needs a description and a positive whole quantity');
      return { description, quantity, unitPriceCents: cents(item.unitPrice) };
    });
    result.shippingCents = cents(input.shipping);
    result.taxCents = cents(input.tax);
    result.totalCents = result.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0) + result.shippingCents + result.taxCents;
    if (!Number.isSafeInteger(result.totalCents) || result.totalCents > 100000000000) throw new Error('Total exceeds the supported limit');
  }
  return result;
}
export function editableBody(body) {
  return { ...body, items: body.items?.map(item => ({ description: item.description, quantity: item.quantity, unitPrice: (item.unitPriceCents / 100).toFixed(2) })), shipping: ((body.shippingCents ?? 0) / 100).toFixed(2), tax: ((body.taxCents ?? 0) / 100).toFixed(2) };
}
