import { randomUUID } from 'node:crypto';
import { RequestError } from './team.mjs';

const amount=value=>{const number=Number(value);if(!Number.isFinite(number)||number<0)throw new RequestError(502,'Provider returned an invalid charge');return Math.round(number*100);};
const fcMoney=value=>{const number=Number(value?.value);if(!Number.isSafeInteger(number)||number<0||!['CAD','USD'].includes(value.currency))throw new RequestError(502,'Freightcom returned an invalid charge');return number;};
export function validateAddress(address) {
  const required=['name','address1','city','provinceCode','countryCodeV2','zip','phone','email'];
  if(!address || required.some(field=>typeof address[field]!=='string'||!address[field].trim()) || !['CA','US'].includes(address.countryCodeV2))throw new RequestError(400,'Complete Canada/USA sender and recipient addresses, phone, and email are required');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.email))throw new RequestError(400,'Shipping contact email is invalid');
  return {...address,address2:address.address2 ?? ''};
}
const easyAddress=a=>({contact_name:a.name,company_name:a.companyName||undefined,line_1:a.address1,line_2:a.address2,state:a.provinceCode,city:a.city,postal_code:a.zip,country_alpha2:a.countryCodeV2,contact_phone:a.phone,contact_email:a.email});
const freightAddress=a=>({name:a.name,address:{address_line_1:a.address1,address_line_2:a.address2,city:a.city,region:a.provinceCode,country:a.countryCodeV2,postal_code:a.zip},contact_name:a.name,phone_number:{number:a.phone},email_addresses:[a.email],receives_email_updates:false});
export function shippingConfig(env=process.env) {return {mode:env.OPS_SHIPPING_MODE??'simulation',easyshipToken:env.EASYSHIP_API_TOKEN,freightcomToken:env.FREIGHTCOM_API_TOKEN,freightcomPaymentMethodId:env.FREIGHTCOM_PAYMENT_METHOD_ID,easyshipEnvironment:env.EASYSHIP_ENVIRONMENT??'production',comparisonCurrency:env.OPS_SHIPPING_COMPARISON_CURRENCY??'CAD'};}
export function createShipping({config=shippingConfig(),fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const live=['live','sandbox'].includes(config.mode),sandbox=config.mode==='sandbox'||config.easyshipEnvironment==='sandbox';
  async function remote(provider,path,{method='GET',body,sideEffect=false}={}) {
    const host=provider==='easyship'?(sandbox?'https://public-api-sandbox.easyship.com/2024-09':'https://public-api.easyship.com/2024-09'):'https://external-api.freightcom.com';
    if(sandbox&&provider==='freightcom')throw new RequestError(503,'Freightcom sandbox API access is unavailable');
    const token=provider==='easyship'?config.easyshipToken:config.freightcomToken;
    if(!token)throw new RequestError(503,`${provider} API credentials are not configured`);
    let response;
    try{response=await fetcher(host+path,{method,headers:{'Content-Type':'application/json',Authorization:provider==='easyship'?`Bearer ${token}`:token},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});}
    catch {const error=new RequestError(502,sideEffect?'Shipping request outcome is unknown. Reconcile before retrying.':'Shipping provider could not be reached');error.unknown=sideEffect;throw error;}
    if(!response.ok){const error=new RequestError(response.status===401||response.status===403?409:502,`${provider} rejected the request (${response.status}); check account permissions and shipment details`);error.unknown=sideEffect&&response.status>=500;throw error;}
    if(response.status===204)return {};
    try{return await response.json();}catch{const error=new RequestError(502,'Shipping provider returned an unreadable response');error.unknown=sideEffect;throw error;}
  }
  function request(order,parcel,origin) {
    const from=validateAddress(origin),to=validateAddress({...order.body.shippingAddress,email:order.body.contact});
    if(typeof from.companyName!=='string'||!from.companyName.trim())throw new RequestError(400,'Sender company name is required for live shipping');
    if(from.countryCodeV2!==to.countryCodeV2)throw new RequestError(409,'Cross-border booking requires approved customs/product declarations; this order is not ready');
    if(!order.body.items?.length)throw new RequestError(409,'Order items are required for shipping');
    if(order.body.items.some(item=>!/^\d{6,10}$/.test(item.hsCode ?? '')))throw new RequestError(409,'Every item requires a verified saved HS classification before requesting shipping rates');
    if(order.body.items.some(item=>typeof item.dangerousGoods!=='boolean'||!['none','in_equipment','packed_with_equipment'].includes(item.battery)))throw new RequestError(409,'Confirm battery and dangerous-goods declarations for every SKU before requesting shipping rates');
    if(order.body.items.some(item=>item.dangerousGoods===true))throw new RequestError(409,'Dangerous-goods shipments require carrier-specific review');
    return {from,to,parcel,orderId:order.id,orderName:order.body.title,store:order.store,currency:config.comparisonCurrency??'CAD',items:order.body.items.map(item=>({description:item.title,sku:item.sku,quantity:item.quantity,hs_code:item.hsCode,origin_country_alpha2:item.countryOfOrigin,contains_battery_pi966:item.battery==='packed_with_equipment',contains_battery_pi967:item.battery==='in_equipment',declared_currency:order.body.currency,declared_customs_value:item.unitPriceCents/100}))};
  }
  function easyPayload(context) {return {origin_address:easyAddress(context.from),destination_address:easyAddress(context.to),shipping_settings:{units:{dimensions:'cm',weight:'kg'},output_currency:context.currency},parcels:[{total_actual_weight:context.parcel.kg,box:{length:context.parcel.length,width:context.parcel.width,height:context.parcel.height},items:context.items}]};}
  function freightPayload(context) {
    const date=new Date(),parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Vancouver',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(date),part=name=>Number(parts.find(p=>p.type===name).value);
    return {origin:freightAddress(context.from),destination:{...freightAddress(context.to),ready_at:{hour:9,minute:0},ready_until:{hour:17,minute:0},signature_requirement:'not-required'},expected_ship_date:{year:part('year'),month:part('month'),day:part('day')},packaging_type:'package',packaging_properties:{packages:[{description:context.parcel.name,measurements:{weight:{unit:'kg',value:context.parcel.kg},cuboid:{unit:'cm',l:context.parcel.length,w:context.parcel.width,h:context.parcel.height}}}]},reference_codes:[`${context.store}:${context.orderName}`]};
  }
  const status=()=>({mode:live?sandbox?'sandbox':'live':'simulation',comparisonCurrency:config.comparisonCurrency??'CAD',providers:[{provider:'easyship',configured:!!config.easyshipToken},{provider:'freightcom',configured:!!config.freightcomToken,bookingConfigured:!!config.freightcomPaymentMethodId}]});
  async function quote(order,parcel,origin) {
    if(!live) {
      const rates=[{provider:'freightcom',service:'Sample ground',serviceId:'sample-ground',priceCents:Math.round(1400+parcel.kg*110),currency:order.body.currency??'CAD',days:4},{provider:'easyship',service:'Sample economy',serviceId:'sample-economy',priceCents:Math.round(1250+parcel.kg*150),currency:order.body.currency??'CAD',days:6}].sort((a,b)=>a.priceCents-b.priceCents);
      return {rates:rates.map(rate=>({...rate,id:randomUUID(),simulated:true,package:parcel})),errors:[],complete:true};
    }
    if(sandbox&&order.body.sampleData!==true)throw new RequestError(409,'Sandbox API verification accepts fictional sample orders only');
    const context=request(order,parcel,origin),requests=await Promise.allSettled([
      (async()=>{const result=await remote('easyship','/rates',{method:'POST',body:easyPayload(context)});if(!Array.isArray(result.rates))throw new RequestError(502,'Easyship returned no rates array');return result.rates.map(rate=>({provider:'easyship',service:rate.courier_service.name,serviceId:rate.courier_service.id,priceCents:amount(rate.total_charge),currency:rate.currency,days:rate.max_delivery_time,details:{shipping:rate.shipment_charge_total,tax:rate.sales_tax,insurance:rate.insurance_fee},context}));})(),
      (async()=>{const details=freightPayload(context),result=await remote('freightcom','/rate',{method:'POST',body:{details}});if(typeof result.request_id!=='string')throw new RequestError(502,'Freightcom returned no rate request ID');let reply;for(let attempt=0;attempt<15;attempt++){reply=await remote('freightcom',`/rate/${encodeURIComponent(result.request_id)}`);if(reply.status?.done)break;await sleep(1500);}if(!reply.status?.done||!Array.isArray(reply.rates))throw new RequestError(502,'Freightcom rate lookup did not finish');return reply.rates.map(rate=>({provider:'freightcom',service:`${rate.carrier_name} ${rate.service_name}`,serviceId:rate.service_id,priceCents:fcMoney(rate.total),currency:rate.total.currency,days:rate.transit_time_not_available?null:rate.transit_time_days,details:{surcharges:rate.surcharges,taxes:rate.taxes},context,providerRequestId:result.request_id}));})()
    ]);
    const rates=[],errors=[];
    requests.forEach((result,index)=>{if(result.status==='fulfilled')rates.push(...result.value);else errors.push({provider:index?'freightcom':'easyship',message:result.reason.message});});
    const comparable=rates.filter(rate=>rate.currency===context.currency && typeof rate.serviceId==='string' && Number.isSafeInteger(rate.priceCents));
    if(rates.length!==comparable.length)errors.push({provider:'comparison',message:'Some rates use a different currency or missing fields and were excluded'});
    comparable.sort((a,b)=>a.priceCents-b.priceCents);
    return {rates:comparable.map(rate=>({...rate,id:randomUUID(),simulated:false,environment:sandbox?'sandbox':'production',package:parcel})),errors,complete:errors.length===0};
  }
  async function retrieve(provider,id) {
    if(provider==='easyship'){
      const data=await remote(provider,`/shipments/${encodeURIComponent(id)}`),s=data.shipment;
      if(!s)throw new RequestError(502,'Easyship shipment was not returned');
      return {externalId:s.easyship_shipment_id,tracking:s.trackings?.[0]?.tracking_number??'',trackingUrl:s.tracking_page_url??'',labelUrl:s.shipping_documents?.find(item=>item.category==='label')?.url??'',state:s.delivery_state,priceCents:s.rates?.[0]?.total_charge===undefined?null:amount(s.rates[0].total_charge),currency:s.currency};
    }
    const data=await remote(provider,`/shipment/${encodeURIComponent(id)}`),s=data.shipment;
    if(!s)throw new RequestError(502,'Freightcom shipment is still being generated');
    return {externalId:s.id,tracking:s.primary_tracking_number??'',trackingUrl:s.tracking_url??'',labelUrl:s.labels?.find(item=>item.format==='pdf')?.url??'',state:s.state,priceCents:s.rate?.total?fcMoney(s.rate.total):null,currency:s.rate?.total?.currency};
  }
  async function book(rate,key,saveReference) {
    if(rate.simulated){return {externalId:`SIM-${key}`,tracking:`SIM-${key}`,trackingUrl:'',labelUrl:'',state:'simulated',priceCents:rate.priceCents,currency:rate.currency};}
    if(!live)throw new RequestError(409,'Live rate cannot be booked in simulation mode');
    let id;
    if(rate.provider==='easyship'){
      const payload=easyPayload(rate.context);delete payload.shipping_settings.output_currency;
      payload.shipping_settings.buy_label=false;payload.courier_settings={courier_service_id:rate.serviceId};payload.metadata={ops_operation:key};payload.order_data={platform_name:`Shopify ${rate.context.store}`,platform_order_number:rate.context.orderName,order_tag_list:[`ops-${key}`]};
      const created=await remote('easyship','/shipments',{method:'POST',body:payload,sideEffect:true});id=created.shipment?.easyship_shipment_id;
      if(!id){const error=new RequestError(502,'Easyship did not return a shipment ID; reconcile before retrying');error.unknown=true;throw error;}
      saveReference(id);
      const actual=created.shipment.rates?.find(item=>item.courier_service.id===rate.serviceId);
      if(!actual || actual.currency!==rate.currency || amount(actual.total_charge)>rate.priceCents)throw new RequestError(409,'Shipment draft created, but its current price exceeds approval or currency changed. No label purchased.');
      await remote('easyship',`/shipments/${encodeURIComponent(id)}/label`,{method:'POST',body:{courier_service_id:rate.serviceId,printing_options:{format:'pdf',label:'4x6'}},sideEffect:true});
    }else{
      if(!config.freightcomPaymentMethodId)throw new RequestError(503,'Freightcom payment method is not configured');
      const currentRequest=await remote('freightcom','/rate',{method:'POST',body:{details:freightPayload(rate.context)}});let currentRates;for(let attempt=0;attempt<15;attempt++){currentRates=await remote('freightcom',`/rate/${encodeURIComponent(currentRequest.request_id)}`);if(currentRates.status?.done)break;await sleep(1500);}const currentRate=currentRates?.rates?.find(item=>item.service_id===rate.serviceId);if(!currentRates?.status?.done||!currentRate||currentRate.total.currency!==rate.currency||fcMoney(currentRate.total)>rate.priceCents)throw new RequestError(409,'Freightcom price changed or lookup is incomplete. Compare rates and approve again before booking');
      const created=await remote('freightcom','/shipment',{method:'POST',body:{unique_id:key,payment_method_id:config.freightcomPaymentMethodId,service_id:rate.serviceId,details:freightPayload(rate.context)},sideEffect:true});id=created.id;
      if(!id){const error=new RequestError(502,'Freightcom did not return a shipment ID; reconcile before retrying');error.unknown=true;throw error;}saveReference(id);
    }
    let shipment;
    for(let attempt=0;attempt<15;attempt++){
      try{shipment=await retrieve(rate.provider,id);if(shipment.tracking)return {...shipment,state:sandbox?'simulated':shipment.state};}catch(error){if(error.status===409)throw error;}await sleep(1500);
    }
    const error=new RequestError(502,'Shipment submitted; tracking is pending. Reconcile this shipment before retrying.');error.unknown=true;throw error;
  }
  async function cancelUnpaidDraft(provider,id,key){
    if(provider!=='easyship')throw new RequestError(409,'Reconcile Freightcom bookings with the provider; this action cannot cancel them');
    const current=await remote('easyship',`/shipments/${encodeURIComponent(id)}`),shipment=current.shipment;
    if(shipment?.label_state!=='not_created'||shipment?.metadata?.ops_operation!==key)throw new RequestError(409,'Only a verified unpaid draft created by this desk can be removed');
    await remote('easyship',`/shipments/${encodeURIComponent(id)}`,{method:'DELETE',sideEffect:true});
  }
  return {status,quote,book,retrieve,cancelUnpaidDraft};
}
