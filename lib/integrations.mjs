import { syncOrderDesk } from './operations.mjs';
import { readFileSync } from 'node:fs';
import { fetchOrderSnapshots } from './shopify-orders.mjs';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';
import { tokenHash } from './store.mjs';
import { RequestError, requireOwner, event } from './team.mjs';

const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const baseShopifyScopes = ['read_orders', 'read_products'];
export function integrationConfig(env = process.env) {
  return { publicUrl: env.OPS_PUBLIC_URL, key: env.OPS_TOKEN_KEY, gmailEmail: env.GOOGLE_WORKSPACE_EMAIL,
    googleClientId: env.GOOGLE_CLIENT_ID, googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    shop: env.SHOPIFY_SHOP, shopifyClientId: env.SHOPIFY_CLIENT_ID, shopifyClientSecret: env.SHOPIFY_CLIENT_SECRET, allowGmailSend: env.OPS_ALLOW_GMAIL_SEND === 'true', allowFulfillment: env.OPS_ALLOW_SHOPIFY_FULFILLMENT === 'true', usaShop: env.SHOPIFY_USA_SHOP, usaClientId: env.SHOPIFY_USA_CLIENT_ID, usaClientSecret: env.SHOPIFY_USA_CLIENT_SECRET };
}
export function encrypt(value, secret, context) {
  if (typeof secret !== 'string' || secret.length < 32) throw new RequestError(503, 'Secure account storage has not been configured');
  const iv = randomBytes(12), key = createHash('sha256').update(secret).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(buffer => buffer.toString('base64url')).join('.');
}
export function decrypt(value, secret, context) {
  try {
    const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { throw new RequestError(503, 'Saved account credentials could not be read. Restore the original encryption key or reconnect the account.'); }
}
function createIntegrationCore(db, { config, fetcher = fetch, shopifyAlias='shopify', providers=['gmail','shopify'] } = {}) {
  const storageName=provider=>provider==='shopify'?shopifyAlias:provider;
  const googleScopes=config.allowGmailSend?[gmailScope,'https://www.googleapis.com/auth/gmail.send']:[gmailScope];
  const shopifyScopes = config.allowFulfillment ? [...baseShopifyScopes,'read_locations','read_merchant_managed_fulfillment_orders','write_merchant_managed_fulfillment_orders'] : baseShopifyScopes;
  const active = new Set();
  function configured(provider) {
    const common = typeof config.key === 'string' && config.key.length >= 32 && /^https:\/\/[^/?#]+\/?$/.test(config.publicUrl ?? '');
    if (provider === 'gmail') return !!(common && config.googleClientId && config.googleClientSecret && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.gmailEmail ?? ''));
    if (provider === 'shopify') return !!(common && config.shopifyClientId && config.shopifyClientSecret && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(config.shop ?? ''));
    return false;
  }
  const callback = provider => `${config.publicUrl.replace(/\/$/, '')}/api/integrations/${storageName(provider)}/callback`;
  function status() {
    return providers.map(provider => {
      const connection = db.prepare('SELECT account,updated_at,last_sync FROM connections WHERE provider=?').get(storageName(provider));
      let fulfillmentEnabled=false,locationsEnabled=false;
      if(provider==='shopify'&&connection&&config.key){try{const stored=db.prepare('SELECT encrypted_tokens FROM connections WHERE provider=?').get(storageName(provider)),scopes=decrypt(stored.encrypted_tokens,config.key,storageName(provider)).scopes?.split(',')??[];fulfillmentEnabled=!!(config.allowFulfillment&&scopes.includes('read_merchant_managed_fulfillment_orders')&&scopes.includes('write_merchant_managed_fulfillment_orders'));locationsEnabled=scopes.includes('read_locations');}catch{}}
      return { provider:storageName(provider), configured: configured(provider), connected: !!connection, account: connection?.account ?? '', connectedAt: connection?.updated_at, lastSync: connection?.last_sync, ...(provider==='shopify'?{fulfillmentEnabled,locationsEnabled}:{}) };
    });
  }
  function save(provider, account, tokens, reconnect = false) {
    const existing = db.prepare('SELECT account FROM connections WHERE provider=?').get(storageName(provider));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (existing && existing.account !== account) db.prepare('DELETE FROM external_records WHERE provider=?').run(storageName(provider));
      db.prepare(`INSERT INTO connections(provider,account,encrypted_tokens,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(provider) DO UPDATE SET account=excluded.account,encrypted_tokens=excluded.encrypted_tokens,updated_at=excluded.updated_at,last_sync=CASE WHEN ? THEN NULL ELSE connections.last_sync END`).run(storageName(provider),account,encrypt(tokens,config.key,storageName(provider)),new Date().toISOString(),reconnect ? 1 : 0);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  async function remote(url, options = {}) {
    let response;
    try { response = await fetcher(url,{ ...options, redirect:'error', signal:AbortSignal.timeout(15000) }); }
    catch { throw new RequestError(502, 'The account provider could not be reached. Try again later.'); }
    if (!response.ok) {
      // Provider response bodies can contain credentials or business data. Never log them.
      const code = response.status === 401 || response.status === 403 ? 409 : response.status === 429 ? 429 : 502;
      throw new RequestError(code, code === 409 ? 'Provider access was denied. Reconnect the account and check its permissions.' : code === 429 ? 'The provider requested a pause. Try syncing later.' : 'The account provider returned an error. Try again later.');
    }
    try { return await response.json(); } catch { throw new RequestError(502, 'The account provider returned an unexpected response'); }
  }
  const sdk = () => shopifyApi({ apiKey:config.shopifyClientId, apiSecretKey:config.shopifyClientSecret, hostName:new URL(config.publicUrl).host, apiVersion:ApiVersion.October26, isEmbeddedApp:false, scopes:shopifyScopes, logger:{level:LogSeverity.Error,log:() => {}} });
  function begin(provider, user, sessionHash) {
    requireOwner(user);
    if (!configured(provider)) throw new RequestError(503, 'This account connection needs initial setup before it can be authorized');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    db.prepare('DELETE FROM oauth_states WHERE expires<=?').run(Date.now());
    db.prepare('INSERT INTO oauth_states(token,provider,user_id,session_hash,verifier,expires) VALUES(?,?,?,?,?,?)').run(tokenHash(state),storageName(provider),user.id,sessionHash,encrypt(verifier,config.key,`${storageName(provider)}.state`),Date.now()+600000);
    if (provider === 'gmail') {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id:config.googleClientId, redirect_uri:callback(provider), response_type:'code', scope:googleScopes.join(' '), state, access_type:'offline', prompt:'consent', login_hint:config.gmailEmail, code_challenge_method:'S256', code_challenge:createHash('sha256').update(verifier).digest('base64url') }).toString();
      return url.toString();
    }
    const url = new URL(`https://${config.shop}/admin/oauth/authorize`);
    url.search = new URLSearchParams({ client_id:config.shopifyClientId, redirect_uri:callback(provider), scope:shopifyScopes.join(','), state }).toString();
    return url.toString();
  }
  async function finish(provider, params, user, sessionHash) {
    requireOwner(user);
    if (!configured(provider)) throw new RequestError(503, 'Account connection is not configured');
    if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) throw new RequestError(400, 'Duplicate callback parameters');
    const state = db.prepare('SELECT * FROM oauth_states WHERE token=? AND provider=? AND expires>?').get(tokenHash(params.get('state') ?? ''),storageName(provider),Date.now());
    if (!state || state.user_id !== user.id || state.session_hash !== sessionHash) throw new RequestError(400, 'Account authorization expired or did not match this session. Connect again.');
    if (provider === 'shopify') {
      let valid = false;
      try { valid = params.get('shop') === config.shop && await sdk().utils.validateHmac(params); } catch {}
      if (!valid) throw new RequestError(400, 'Shopify callback signature or store did not match');
    }
    db.prepare('DELETE FROM oauth_states WHERE token=?').run(state.token);
    if (params.has('error') || !params.get('code')) throw new RequestError(400, 'Account permission was not granted. Connect again when ready.');
    if (provider === 'gmail') {
      const response = await remote('https://oauth2.googleapis.com/token',{ method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ client_id:config.googleClientId, client_secret:config.googleClientSecret, code:params.get('code'), code_verifier:decrypt(state.verifier,config.key,`${storageName(provider)}.state`), redirect_uri:callback(provider), grant_type:'authorization_code' }).toString() });
      if (!response.access_token || !response.refresh_token || !response.scope?.split(' ').includes(gmailScope)) throw new RequestError(400, 'Google did not grant the inbox permission or offline access. Connect again and accept the requested permission.');
      const profile = await remote('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${response.access_token}`}});
      if (profile.emailAddress?.toLowerCase() !== config.gmailEmail.toLowerCase()) throw new RequestError(400, 'Connect the configured business mailbox, rather than a different Google account');
      save(provider,profile.emailAddress,{accessToken:response.access_token,refreshToken:response.refresh_token,scopes:response.scope,expiresAt:Date.now()+Number(response.expires_in ?? 3600)*1000},true);
    } else {
      const response = await remote(`https://${config.shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:config.shopifyClientId,client_secret:config.shopifyClientSecret,code:params.get('code')})});
      if (!response.access_token || !shopifyScopes.every(scope => response.scope?.split(',').includes(scope))) throw new RequestError(400, 'Shopify did not grant the requested order and product permissions');
      save(provider,config.shop,{accessToken:response.access_token,refreshToken:response.refresh_token,scopes:response.scope,expiresAt:response.expires_in ? Date.now()+response.expires_in*1000 : null},true);
    }
    event(db,user,`Connected ${provider}`);
  }
  async function accessToken(provider) {
    const row = db.prepare('SELECT * FROM connections WHERE provider=?').get(storageName(provider));
    if (!row) throw new RequestError(409, 'Connect the account before syncing');
    const tokens = decrypt(row.encrypted_tokens,config.key,storageName(provider));
    if (!tokens.expiresAt || tokens.expiresAt > Date.now()+60000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new RequestError(409, 'Account access expired. Reconnect the account.');
    const response = provider === 'gmail'
      ? await remote('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.googleClientId,client_secret:config.googleClientSecret,refresh_token:tokens.refreshToken,grant_type:'refresh_token'}).toString()})
      : await remote(`https://${config.shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:config.shopifyClientId,client_secret:config.shopifyClientSecret,refresh_token:tokens.refreshToken,grant_type:'refresh_token'})});
    if (!response.access_token) throw new RequestError(502, 'Account access could not be refreshed');
    save(provider,row.account,{accessToken:response.access_token,refreshToken:response.refresh_token ?? tokens.refreshToken,scopes:response.scope ?? tokens.scopes,expiresAt:Date.now()+Number(response.expires_in ?? 3600)*1000});
    return response.access_token;
  }
  async function sync(provider, user) {
    requireOwner(user);
    if (!configured(provider)) throw new RequestError(503, 'Account connection is not configured');
    if (active.has(provider)) throw new RequestError(409, 'A sync is already running');
    active.add(provider);
    try {
      const token = await accessToken(provider), imported = [];
      if (provider === 'gmail') {
        const headers = {Authorization:`Bearer ${token}`};
        const items=[],seenMessages=new Set(),seenPages=new Set();let pageToken=null;
        do {const params=new URLSearchParams({labelIds:'INBOX',maxResults:'100',...(pageToken?{pageToken}:{})}),list=await remote(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,{headers});
          for(const item of list.messages ?? [])if(!seenMessages.has(item.id)){items.push(item);seenMessages.add(item.id);}
          pageToken=list.nextPageToken??null;if(pageToken&&seenPages.has(pageToken))throw new RequestError(502,'Gmail repeated a page cursor');if(pageToken)seenPages.add(pageToken);
        }while(pageToken);
        for (let start=0;start<items.length;start+=5) {
          const batch = await Promise.all(items.slice(start,start+5).map(async item => {
          if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id)) throw new RequestError(502,'Unexpected mailbox message identifier');
          const message = await remote(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,{headers});
          const header = name => message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
          return {id:item.id,type:'message',body:{title:header('Subject') || '(No subject)',contact:header('From'),notes:message.snippet ?? '',date:header('Date'),threadId:message.threadId}};
          }));
          imported.push(...batch);
        }
      } else {
        const graphql = body => remote(`https://${config.shop}/admin/api/2026-10/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify(body)});
        imported.push(...await fetchOrderSnapshots(graphql,config.shop));
        const data = await graphql({query:`query OperationsProducts { products(first:25,sortKey:UPDATED_AT,reverse:true) { nodes { id title handle status vendor } } }`});
        if(data.errors?.length || !Array.isArray(data.data?.products?.nodes))throw new RequestError(502,'Shopify could not return products');
        for (const product of data.data.products.nodes) imported.push({id:product.id,type:'product',body:{title:product.title,handle:product.handle,status:product.status,vendor:product.vendor}});
      }
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        // This is a bounded snapshot, not a full mailbox or store archive.
        db.prepare('DELETE FROM external_records WHERE provider=?').run(storageName(provider));
        for (const record of imported) db.prepare('INSERT INTO external_records(provider,external_id,type,body,synced_at) VALUES(?,?,?,?,?)').run(storageName(provider),record.id,record.type,JSON.stringify(record.body),now);
        db.prepare('UPDATE connections SET last_sync=? WHERE provider=?').run(now,storageName(provider));
        event(db,user,`Synced ${provider}: ${imported.length} records`);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      syncOrderDesk(db,user);
      return { count:imported.length, syncedAt:now };
    } finally { active.delete(provider); }
  }
  async function handle({ path, req, body, user, sessionHash, json, res, url }) {
    if (!path.startsWith('/api/integrations')) return false;
    if (!user) throw new RequestError(401, 'Sign in required');
    if (req.method === 'GET' && path === '/api/integrations') { json(200,status()); return true; }
    if (req.method === 'GET' && path === '/api/integrations/records') {
      json(200,db.prepare('SELECT * FROM external_records ORDER BY provider,type,external_id').all().filter(row=>user.role==='owner'||row.provider!=='gmail').map(row => ({...row,body:JSON.parse(row.body)}))); return true;
    }
    const match = path.match(/^\/api\/integrations\/(gmail|shopify)\/(connect|callback|sync|disconnect|locations)$/);
    if (!match) return false;
    const [,provider,action] = match;
    requireOwner(user);
    if(req.method==='GET'&&action==='locations'&&provider==='shopify'){json(200,await locations());return true;}
    if (req.method === 'POST' && action === 'connect') { json(200,{url:begin(provider,user,sessionHash)}); return true; }
    if (req.method === 'GET' && action === 'callback') {
      await finish(provider,url.searchParams,user,sessionHash);
      res.writeHead(303,{Location:'/?view=connections'}); res.end(); return true;
    }
    if (req.method === 'POST' && action === 'sync') { json(200,await sync(provider,user)); return true; }
    if (req.method === 'POST' && action === 'disconnect') {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM connections WHERE provider=?').run(storageName(provider));
        db.prepare('DELETE FROM external_records WHERE provider=?').run(storageName(provider));
        db.prepare('DELETE FROM oauth_states WHERE provider=?').run(storageName(provider));
        event(db,user,`Disconnected ${provider}; provider-side permissions still require revocation`);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      json(200,{ok:true}); return true;
    }
    return false;
  }
  const document=name=>readFileSync(new URL(`../graphql/${name}.graphql`,import.meta.url),'utf8');
  async function shopifyGraphql(store,body) {
    if(store!==config.shop)throw new RequestError(409,'This Shopify store is not connected');
    const token=await accessToken('shopify');
    const data=await remote(`https://${store}/admin/api/2026-10/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify(body)});
    if(data.errors?.length)throw new RequestError(409,'Shopify request failed; check scopes, store access, and protected-data approval');return data.data;
  }
  async function locations() {
    const row=db.prepare('SELECT encrypted_tokens FROM connections WHERE provider=?').get(storageName('shopify'));
    if(!row||!decrypt(row.encrypted_tokens,config.key,storageName('shopify')).scopes?.split(',').includes('read_locations'))throw new RequestError(409,'Reconnect Shopify with location-reading permission first');
    const output=[],seen=new Set();let after=null;
    while(true){const result=await shopifyGraphql(config.shop,{query:document('locations'),variables:{after}}),connection=result?.locations;
      if(!Array.isArray(connection?.nodes))throw new RequestError(502,'Shopify did not return warehouse locations');
      for(const location of connection.nodes){if(seen.has(location.id))throw new RequestError(502,'Shopify repeated a location');seen.add(location.id);if(location.isActive&&location.fulfillsOnlineOrders)output.push({...location,store:config.shop,address:{...location.address,countryCodeV2:location.address.countryCode}});}
      if(!connection.pageInfo?.hasNextPage)break;const cursor=connection.pageInfo.endCursor;if(!cursor||cursor===after||seen.size>10000)throw new RequestError(502,'Shopify location pagination did not finish');after=cursor;
    }
    return output;
  }
  async function verifyOrder(order,origin) {
    if(!config.allowFulfillment)throw new RequestError(503,'Complete Shopify fulfillment authorization before booking a live label');
    const connection=db.prepare('SELECT * FROM connections WHERE provider=?').get(storageName('shopify'));
    const scopes=connection?decrypt(connection.encrypted_tokens,config.key,storageName('shopify')).scopes?.split(','):[];
    if(!scopes?.includes('read_merchant_managed_fulfillment_orders')||!scopes.includes('write_merchant_managed_fulfillment_orders'))throw new RequestError(409,'Reconnect Shopify with approved fulfillment permissions before buying a label');
    const data=await shopifyGraphql(order.store,{query:document('order-state'),variables:{id:order.external_id}});
    if(!data.order || !order.body.providerUpdatedAt || data.order.updatedAt!==order.body.providerUpdatedAt || data.order.cancelledAt || data.order.displayFulfillmentStatus==='FULFILLED')throw new RequestError(409,'Shopify order changed or is no longer fulfillable. Sync it and review shipping again');
    if(origin){if(typeof origin.locationId!=='string'||!origin.locationId.startsWith('gid://shopify/Location/'))throw new RequestError(409,'Choose the Shopify fulfillment location for this shipping origin before booking');const query=document('fulfillment-order').split('mutation ')[0],details=await shopifyGraphql(order.store,{query,variables:{id:order.external_id,after:null}}),rows=details.order?.fulfillmentOrders?.nodes ?? [];const active=rows.filter(row=>row.status==='OPEN'&&row.lineItems.nodes.some(item=>order.body.items.some(expected=>expected.lineId===item.lineItem.id&&item.remainingQuantity>0)));if(!active.length||active.some(row=>row.assignedLocation?.location?.id!==origin.locationId)||details.order?.fulfillmentOrders?.pageInfo.hasNextPage)throw new RequestError(409,'Order fulfillment location needs routing review before label purchase');}
  }
  async function fulfill(order,shipment) {
    if(!config.allowFulfillment)throw new RequestError(503,'Shopify fulfillment writes are disabled pending scope authorization');
    if(!shipment.tracking || shipment.tracking.startsWith('SIM-'))throw new RequestError(409,'Verified provider tracking is required');
    await verifyOrder(order);
    const needed=new Map(order.body.items.map(item=>[item.lineId,item.quantity]));
    if(needed.has(undefined))throw new RequestError(409,'Shopify line-item IDs are required');
    const documentText=document('fulfillment-order'),query=documentText.slice(0,documentText.indexOf('mutation ')),orders=[],locations=new Set();let after=null;
    const seen=new Set();
    do {
      const data=await shopifyGraphql(order.store,{query,variables:{id:order.external_id,after}}),connection=data.order?.fulfillmentOrders;
      if(!connection)throw new RequestError(409,'Shopify fulfillment orders were not returned');
      for(const row of connection.nodes){
        let cursor=row.lineItems.pageInfo.hasNextPage?row.lineItems.pageInfo.endCursor:null;const lineSeen=new Set();
        while(cursor){if(lineSeen.has(cursor))throw new RequestError(502,'Repeated fulfillment-line cursor');lineSeen.add(cursor);const extra=await shopifyGraphql(order.store,{query:document('fulfillment-lines'),variables:{id:row.id,after:cursor}}),lines=extra.fulfillmentOrder?.lineItems;if(!lines)throw new RequestError(409,'Fulfillment lines were not returned');row.lineItems.nodes.push(...lines.nodes);cursor=lines.pageInfo.hasNextPage?lines.pageInfo.endCursor:null;}
        if(row.status!=='OPEN')continue;
        const selected=[];for(const line of row.lineItems.nodes){const remaining=needed.get(line.lineItem.id)??0,take=Math.min(remaining,line.remainingQuantity);if(take>0){selected.push({id:line.id,quantity:take});needed.set(line.lineItem.id,remaining-take);}}
        if(selected.length){locations.add(row.assignedLocation?.location?.id);orders.push({fulfillmentOrderId:row.id,fulfillmentOrderLineItems:selected});}
      }
      after=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;
      if(after&&seen.has(after))throw new RequestError(502,'Repeated fulfillment-order cursor');seen.add(after);
    }while(after);
    if(locations.size!==1 || locations.has(undefined))throw new RequestError(409,'This order requires location-specific shipments. Review routing before fulfillment');
    if(!orders.length||[...needed.values()].some(quantity=>quantity>0))throw new RequestError(409,'Shopify fulfillment quantities do not match scanned items');
    const mutation=documentText.slice(documentText.indexOf('mutation '));
    const data=await shopifyGraphql(order.store,{query:mutation,variables:{fulfillment:{notifyCustomer:false,trackingInfo:{number:shipment.tracking,url:shipment.trackingUrl||undefined},lineItemsByFulfillmentOrder:orders}}});
    if(data.fulfillmentCreate?.userErrors?.length || !data.fulfillmentCreate?.fulfillment?.id)throw new RequestError(409,'Shopify rejected fulfillment; review the booked shipment before retrying');
    return data.fulfillmentCreate.fulfillment;
  }
  function outboundMessageId(key) {return `<ops-${key}@${new URL(config.publicUrl).hostname}>`;}
  async function sendGmail(payload,key) {
    if(!config.allowGmailSend)throw new RequestError(503,'Gmail sending is disabled pending scope authorization');
    const row=db.prepare("SELECT * FROM connections WHERE provider='gmail'").get();
    const scopes=row?decrypt(row.encrypted_tokens,config.key,'gmail').scopes?.split(' '):[];
    if(!scopes?.includes('https://www.googleapis.com/auth/gmail.send'))throw new RequestError(409,'Reconnect Gmail with approved sending permission');
    const token=await accessToken('gmail');
    const subjectWords=[];let chunk='';
    for(const char of payload.subject){if(Buffer.byteLength(chunk+char)>45){subjectWords.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);chunk='';}chunk+=char;}
    if(chunk)subjectWords.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
    const content=Buffer.from(payload.content).toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
    const mime=[`From: ${config.gmailEmail}`,`To: ${payload.to}`,`Subject: ${subjectWords.join('\r\n ')}`,`Message-ID: ${outboundMessageId(key)}`,`Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',content].join('\r\n');
    let result;
    try{result=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({raw:Buffer.from(mime).toString('base64url')}),redirect:'error',signal:AbortSignal.timeout(25000)});}
    catch{const error=new RequestError(502,'Email send outcome is unknown. Check Sent mail before retrying');error.unknown=true;throw error;}
    if(!result.ok){const error=new RequestError(502,`Gmail rejected sending (${result.status})`);error.unknown=result.status>=500;throw error;}
    let message;try{message=await result.json();}catch{const error=new RequestError(502,'Gmail send outcome is unreadable; reconcile before retrying');error.unknown=true;throw error;}
    if(!message.id){const error=new RequestError(502,'Gmail did not return a message ID; reconcile before retrying');error.unknown=true;throw error;}
    return message;
  }
  async function reconcileGmail(key) {const token=await accessToken('gmail'),query=new URLSearchParams({q:`rfc822msgid:${outboundMessageId(key)}`,maxResults:'2'});const result=await remote(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`,{headers:{Authorization:`Bearer ${token}`}});if(result.messages?.length!==1)throw new RequestError(409,'A single sent message could not be verified. Inspect Sent mail; no resend will occur');return result.messages[0];}
  function capabilities(){let enabled=false;try{const row=db.prepare("SELECT encrypted_tokens FROM connections WHERE provider='gmail'").get();enabled=!!(config.allowGmailSend&&row&&decrypt(row.encrypted_tokens,config.key,'gmail').scopes?.split(' ').includes('https://www.googleapis.com/auth/gmail.send'));}catch{}return {gmailSendEnabled:enabled};}
  return { handle, status, begin, finish, sync,verifyOrder,fulfill,sendGmail,reconcileGmail,capabilities };
}

export function createIntegrations(db,{config=integrationConfig(),fetcher=fetch}={}) {
  const primary=createIntegrationCore(db,{config,fetcher});
  const usaConfig={...config,shop:config.usaShop,shopifyClientId:config.usaClientId,shopifyClientSecret:config.usaClientSecret};
  const usa=createIntegrationCore(db,{config:usaConfig,fetcher,shopifyAlias:'shopify_usa',providers:['shopify']});
  const select=provider=>provider==='shopify_usa'?usa:primary;
  const generic=provider=>provider==='shopify_usa'?'shopify':provider;
  const forStore=store=>store===config.shop?primary:store===config.usaShop?usa:null;
  return {
    status:()=>[...primary.status(),...usa.status()],
    capabilities:()=>primary.capabilities(),
    sendGmail:(...args)=>primary.sendGmail(...args),
    reconcileGmail:(...args)=>primary.reconcileGmail(...args),
    begin:(provider,...args)=>select(provider).begin(generic(provider),...args),
    finish:(provider,...args)=>select(provider).finish(generic(provider),...args),
    sync:(provider,...args)=>select(provider).sync(generic(provider),...args),
    verifyOrder:(order,origin)=>{const core=forStore(order.store);if(!core)throw new RequestError(409,'Order store is not connected');return core.verifyOrder(order,origin);},
    fulfill:(order,shipment)=>{const core=forStore(order.store);if(!core)throw new RequestError(409,'Order store is not connected');return core.fulfill(order,shipment);},
    handle:async context=>{
      if(context.req.method==='GET'&&context.path==='/api/integrations'){if(!context.user)throw new RequestError(401,'Sign in required');context.json(200,[...primary.status(),...usa.status()]);return true;}
      if(context.path.startsWith('/api/integrations/shopify_usa/'))return usa.handle({...context,path:context.path.replace('/api/integrations/shopify_usa/','/api/integrations/shopify/')});
      return primary.handle(context);
    }
  };
}
