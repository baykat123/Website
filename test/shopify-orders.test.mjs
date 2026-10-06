import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchOrderSnapshots,normalizeOrder} from '../lib/shopify-orders.mjs';
const money=amount=>({shopMoney:{amount,currencyCode:'CAD'}});
const line=(id,quantity=1,remaining=1,total='10.00')=>({id,title:'Part',sku:`SKU-${id}`,currentQuantity:quantity,unfulfilledQuantity:remaining,requiresShipping:true,variant:{id:`variant-${id}`,barcode:`barcode-${id}`},originalUnitPriceSet:money('10.00'),priceAfterAllDiscountsBeforeTaxesSet:money(total)});
const order=(id,lines)=>({id,name:`#${id}`,updatedAt:'2026-10-06T00:00:00Z',displayFinancialStatus:'PAID',displayFulfillmentStatus:'PARTIALLY_FULFILLED',email:'sample@example.com',currentTotalPriceSet:money('21.00'),currentShippingPriceSet:money('1.00'),currentTotalTaxSet:money('0.00'),lineItems:{nodes:lines,pageInfo:{hasNextPage:false}}});
test('complete order imports paginate both orders and lines and retain remaining quantities and exact discounted totals',async()=>{
  let calls=0;const fetcher=async({query,variables})=>{
    calls++;
    if(query.includes('OperationsOrderLines'))return {data:{order:{lineItems:{nodes:[line('extra')],pageInfo:{hasNextPage:false}}}}};
    if(variables.after==='second')return {data:{orders:{nodes:[order('two',[line('second',2,1,'20.00')])],pageInfo:{hasNextPage:false}}}};
    const first=order('one',[line('first',2,0)]);first.lineItems.pageInfo={hasNextPage:true,endCursor:'more-lines'};
    return {data:{orders:{nodes:[first],pageInfo:{hasNextPage:true,endCursor:'second'}}}};
  };
  const rows=await fetchOrderSnapshots(fetcher,'sample.myshopify.com');assert.equal(calls,3);assert.equal(rows.length,2);
  assert.equal(rows[0].body.invoiceItems.length,2);assert.equal(rows[0].body.items.length,1);assert.equal(rows[0].body.items[0].barcode,'barcode-extra');
  assert.equal(rows[1].body.items[0].quantity,1);assert.equal(rows[1].body.invoiceItems[0].quantity,2);assert.equal(rows[1].body.invoiceItems[0].lineTotalCents,2000);assert.equal(rows[1].body.reconciled,true);
  await assert.rejects(fetchOrderSnapshots(async()=>({errors:[{message:'Denied'}]}),'sample.myshopify.com'),/permissions/);
});
test('unreconciled and unsupported-currency orders cannot silently become matched invoice totals',()=>{
  const row=normalizeOrder(order('three',[line('discounted',3,3,'19.99')]),'sample');assert.equal(row.reconciled,false);
  assert.throws(()=>normalizeOrder({...order('four',[]),currentTotalPriceSet:{shopMoney:{amount:'1',currencyCode:'JPY'}}},'sample'),/supported money/);
});

test('shipping classifications come from the provider without inventing missing battery declarations',()=>{
  const item=line('classified');item.variant.inventoryItem={harmonizedSystemCode:'392690',countryCodeOfOrigin:'CA'};
  const normalized=normalizeOrder(order('classified',[item]),'sample').items[0];
  assert.equal(normalized.hsCode,'392690');assert.equal(normalized.countryOfOrigin,'CA');assert.equal(normalized.battery,undefined);assert.equal(normalized.dangerousGoods,undefined);
});
