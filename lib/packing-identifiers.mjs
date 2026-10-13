import {createHash} from 'node:crypto';
// A desk label identifies an exact Shopify order line; it is not a fabricated
// product SKU. Custom jobs can share a variant while containing different parts.
export function shippingProfileKey(item) {
  if(typeof item.sku==='string'&&item.sku.trim())return item.sku.trim();
  const id=typeof item.lineId==='string'&&item.lineId.match(/^gid:\/\/shopify\/LineItem\/(\d+)$/)?.[1];
  return id?`OPS-L-${id}`:'';
}
export function packingCode(item) {
  const code=shippingProfileKey(item);
  if(!code||item.sku?.trim()||!item.customAttributes?.length)return code;
  const details=[item.title??'',...item.customAttributes.map(a=>[a.key,a.value]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))];
  return `${code}-${createHash('sha256').update(JSON.stringify(details)).digest('hex').slice(0,8)}`;
}
export function packingItems(items=[]) {
  return items.map(item=>({...item,packingCode:packingCode(item),profileKey:shippingProfileKey(item),deskLabel:!item.sku?.trim(),customAttributes:item.customAttributes??[]}));
}
