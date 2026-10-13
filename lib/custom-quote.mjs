export function customQuoteInfo(item) {
  const attributes=new Map((item.customAttributes??[]).map(a=>[String(a.key).toLowerCase().trim(),String(a.value).trim()]));
  const generic=String(item.title).toLowerCase().trim()==='custom 3d print',quote=attributes.get('quote');
  const encoded=generic&&(quote==='NEX3D Instant Quote'||item.unitPriceCents===1);
  if(!encoded)return {encoded:false,quantity:item.quantity,title:item.title,serviceCharge:false};
  const part=attributes.get('part')??'';
  if(quote!=='NEX3D Instant Quote'||item.unitPriceCents!==1)return {encoded:true,quantity:null,title:part||item.title,serviceCharge:false,reviewReason:'Custom print pricing metadata needs a verified physical piece count'};
  if(/^Order minimum \((?:CAD|USD) \$[0-9]+(?:\.[0-9]{2})?\)$/i.test(part))return {encoded:true,quantity:0,title:'Minimum order adjustment',serviceCharge:true};
  const pieces=attributes.get('pieces')??'',count=Number(pieces),full=item.financialQuantity??item.quantity;
  if(!/^[1-9][0-9]*$/.test(pieces)||!Number.isSafeInteger(count)||count>1000000)return {encoded:true,quantity:null,title:part||item.title,serviceCharge:false,reviewReason:'Custom quote has no verified physical piece count'};
  if(item.quantity!==full)return {encoded:true,quantity:null,title:part||item.title,serviceCharge:false,reviewReason:'Partially fulfilled pricing units need a verified remaining piece count'};
  const value=Number.isSafeInteger(item.lineTotalCents)?item.lineTotalCents:item.quantity*item.unitPriceCents;
  return {encoded:true,quantity:count,title:part||item.title,serviceCharge:false,shippingUnitValueCents:Math.ceil(value/count)};
}
export function jobAttributes(item) {
  const excluded=customQuoteInfo(item).encoded?new Set(['quote','quoted total','name','email']):new Set();
  return (item.customAttributes??[]).filter(a=>!excluded.has(String(a.key).toLowerCase().trim()));
}
export function invoiceDescription(item) {
  const info=customQuoteInfo(item);
  if(info.serviceCharge)return info.title;
  if(info.encoded&&info.quantity!==null)return `${info.title} (${info.quantity} ${info.quantity===1?'piece':'pieces'})`;
  if(info.encoded)return `${info.title} (physical piece count requires review)`;
  return Number.isSafeInteger(item.lineTotalCents)?`${item.title||item.sku} (${item.quantity} units)`:item.title||item.sku;
}
