import {createHash} from 'node:crypto';
import {customQuoteInfo,jobAttributes} from './custom-quote.mjs';
// A desk label identifies an exact Shopify order line; it is not a fabricated
// product SKU. Custom jobs can share a variant while containing different parts.
export function shippingProfileKey(item) {
  if(!customQuoteInfo(item).encoded&&typeof item.sku==='string'&&item.sku.trim())return item.sku.trim();
  const id=typeof item.lineId==='string'&&item.lineId.match(/^gid:\/\/shopify\/LineItem\/(\d+)$/)?.[1];
  return id?`OPS-L-${id}`:'';
}
export function packingCode(item) {
  if(customQuoteInfo(item).serviceCharge)return '';
  const code=shippingProfileKey(item);
  const attributes=jobAttributes(item);
  if(!code||(!customQuoteInfo(item).encoded&&item.sku?.trim())||!attributes.length)return code;
  const details=[item.title??'',...attributes.map(a=>[a.key,a.value]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))];
  return `${code}-${createHash('sha256').update(JSON.stringify(details)).digest('hex').slice(0,8)}`;
}
export function packingItems(items=[]) {
  return items.map(item=>{const info=customQuoteInfo(item);return {...item,fulfillmentQuantity:item.quantity,quantity:info.quantity,packingTitle:info.title,packingCode:packingCode(item),profileKey:shippingProfileKey(item),deskLabel:info.encoded||!item.sku?.trim(),priceEncoded:info.encoded,serviceCharge:info.serviceCharge,reviewReason:info.reviewReason,shippingUnitValueCents:info.shippingUnitValueCents,customAttributes:item.customAttributes??[],jobAttributes:jobAttributes(item)};});
}
export function packingOrderItems(body) {
  const invoices=new Map((body.invoiceItems??[]).map(i=>[i.lineId,i]));
  return packingItems((body.items??[]).map(item=>({...item,financialQuantity:item.financialQuantity??invoices.get(item.lineId)?.quantity??item.quantity})));
}
