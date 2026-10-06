import { readFileSync } from 'node:fs';
import { cents } from './records.mjs';
import { RequestError } from './team.mjs';

const query=readFileSync(new URL('../graphql/order-import.graphql',import.meta.url),'utf8');
const linesQuery=readFileSync(new URL('../graphql/order-lines.graphql',import.meta.url),'utf8');
export function normalizeOrder(node,store) {
  const money=node.currentTotalPriceSet?.shopMoney;
  if(!money || !['CAD','USD'].includes(money.currencyCode) || !Array.isArray(node.lineItems?.nodes)) throw new RequestError(502,'Shopify order is missing complete supported money or line-item data');
  const invoiceItems=node.lineItems.nodes.filter(item=>item.currentQuantity>0).map(item=>({
    lineId:item.id,sku:item.sku ?? '',barcode:item.variant?.barcode ?? '',variantId:item.variant?.id,
    hsCode:item.variant?.inventoryItem?.harmonizedSystemCode ?? '',countryOfOrigin:item.variant?.inventoryItem?.countryCodeOfOrigin ?? '',
    title:item.title,quantity:item.currentQuantity,remainingQuantity:item.unfulfilledQuantity,requiresShipping:item.requiresShipping,
    unitPriceCents:cents(item.originalUnitPriceSet?.shopMoney?.amount),lineTotalCents:cents(item.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney?.amount)
  }));
  const shippingCents=node.currentShippingPriceSet?.shopMoney ? cents(node.currentShippingPriceSet.shopMoney.amount) : null;
  const taxCents=node.currentTotalTaxSet?.shopMoney ? cents(node.currentTotalTaxSet.shopMoney.amount) : null;
  const reconciled=shippingCents!==null && taxCents!==null && invoiceItems.reduce((sum,item)=>sum+item.lineTotalCents,0)+shippingCents+taxCents===cents(money.amount);
  return {title:node.name,store,date:node.createdAt,providerUpdatedAt:node.updatedAt,cancelledAt:node.cancelledAt,contact:node.email ?? '',providerNote:node.note ?? '',financialStatus:node.displayFinancialStatus,fulfillmentStatus:node.displayFulfillmentStatus,amount:money.amount,currency:money.currencyCode,shippingAddress:node.shippingAddress,shippingCents,taxCents,taxesIncluded:node.taxesIncluded,invoiceItems,reconciled,
    items:invoiceItems.filter(item=>item.requiresShipping && item.remainingQuantity>0).map(item=>({...item,quantity:item.remainingQuantity}))};
}
export async function fetchOrderSnapshots(graphql,store) {
  const imported=[],seen=new Set();let after=null;
  while(true) {
    const data=await graphql({query,variables:{after}});
    if(data.errors?.length || !Array.isArray(data.data?.orders?.nodes)) throw new RequestError(502,'Shopify could not return complete orders. Check order/customer-data permissions.');
    for(const node of data.data.orders.nodes) {
      if(seen.has(node.id))throw new RequestError(502,'Shopify returned duplicate order pages');seen.add(node.id);
      let lineAfter=node.lineItems?.pageInfo?.hasNextPage ? node.lineItems.pageInfo.endCursor : null;
      const cursors=new Set();
      while(lineAfter) {
        if(cursors.has(lineAfter))throw new RequestError(502,'Shopify repeated a line-item cursor');cursors.add(lineAfter);
        const extra=await graphql({query:linesQuery,variables:{id:node.id,after:lineAfter}}),connection=extra.data?.order?.lineItems;
        if(extra.errors?.length || !Array.isArray(connection?.nodes))throw new RequestError(502,'Shopify line-item pagination failed');
        node.lineItems.nodes.push(...connection.nodes);
        if(connection.pageInfo?.hasNextPage && !connection.pageInfo.endCursor)throw new RequestError(502,'Shopify line-item cursor was missing');
        lineAfter=connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
      }
      if(node.lineItems?.pageInfo?.hasNextPage && !node.lineItems.pageInfo.endCursor)throw new RequestError(502,'Shopify line-item cursor was missing');
      imported.push({id:node.id,type:'order',body:normalizeOrder(node,store)});
    }
    if(!data.data.orders.pageInfo?.hasNextPage)break;
    const cursor=data.data.orders.pageInfo.endCursor;
    if(!cursor || cursor===after || imported.length>100000)throw new RequestError(502,'Shopify pagination did not complete');after=cursor;
  }
  return imported;
}
