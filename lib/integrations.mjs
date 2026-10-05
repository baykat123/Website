import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';
import { tokenHash } from './store.mjs';
import { RequestError, requireOwner, event } from './team.mjs';

const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const shopifyScopes = ['read_orders', 'read_products'];
export function integrationConfig(env = process.env) {
  return { publicUrl: env.OPS_PUBLIC_URL, key: env.OPS_TOKEN_KEY, gmailEmail: env.GOOGLE_WORKSPACE_EMAIL,
    googleClientId: env.GOOGLE_CLIENT_ID, googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    shop: env.SHOPIFY_SHOP, shopifyClientId: env.SHOPIFY_CLIENT_ID, shopifyClientSecret: env.SHOPIFY_CLIENT_SECRET };
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
export function createIntegrations(db, { config = integrationConfig(), fetcher = fetch } = {}) {
  const active = new Set();
  function configured(provider) {
    const common = typeof config.key === 'string' && config.key.length >= 32 && /^https:\/\/[^/?#]+\/?$/.test(config.publicUrl ?? '');
    if (provider === 'gmail') return !!(common && config.googleClientId && config.googleClientSecret && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.gmailEmail ?? ''));
    if (provider === 'shopify') return !!(common && config.shopifyClientId && config.shopifyClientSecret && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(config.shop ?? ''));
    return false;
  }
  const callback = provider => `${config.publicUrl.replace(/\/$/, '')}/api/integrations/${provider}/callback`;
  function status() {
    return ['gmail','shopify'].map(provider => {
      const connection = db.prepare('SELECT account,updated_at,last_sync FROM connections WHERE provider=?').get(provider);
      return { provider, configured: configured(provider), connected: !!connection, account: connection?.account ?? '', connectedAt: connection?.updated_at, lastSync: connection?.last_sync };
    });
  }
  function save(provider, account, tokens, reconnect = false) {
    const existing = db.prepare('SELECT account FROM connections WHERE provider=?').get(provider);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (existing && existing.account !== account) db.prepare('DELETE FROM external_records WHERE provider=?').run(provider);
      db.prepare(`INSERT INTO connections(provider,account,encrypted_tokens,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(provider) DO UPDATE SET account=excluded.account,encrypted_tokens=excluded.encrypted_tokens,updated_at=excluded.updated_at,last_sync=CASE WHEN ? THEN NULL ELSE connections.last_sync END`).run(provider,account,encrypt(tokens,config.key,provider),new Date().toISOString(),reconnect ? 1 : 0);
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
    db.prepare('INSERT INTO oauth_states(token,provider,user_id,session_hash,verifier,expires) VALUES(?,?,?,?,?,?)').run(tokenHash(state),provider,user.id,sessionHash,encrypt(verifier,config.key,`${provider}.state`),Date.now()+600000);
    if (provider === 'gmail') {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id:config.googleClientId, redirect_uri:callback(provider), response_type:'code', scope:gmailScope, state, access_type:'offline', prompt:'consent', login_hint:config.gmailEmail, code_challenge_method:'S256', code_challenge:createHash('sha256').update(verifier).digest('base64url') }).toString();
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
    const state = db.prepare('SELECT * FROM oauth_states WHERE token=? AND provider=? AND expires>?').get(tokenHash(params.get('state') ?? ''),provider,Date.now());
    if (!state || state.user_id !== user.id || state.session_hash !== sessionHash) throw new RequestError(400, 'Account authorization expired or did not match this session. Connect again.');
    if (provider === 'shopify') {
      let valid = false;
      try { valid = params.get('shop') === config.shop && await sdk().utils.validateHmac(params); } catch {}
      if (!valid) throw new RequestError(400, 'Shopify callback signature or store did not match');
    }
    db.prepare('DELETE FROM oauth_states WHERE token=?').run(state.token);
    if (params.has('error') || !params.get('code')) throw new RequestError(400, 'Account permission was not granted. Connect again when ready.');
    if (provider === 'gmail') {
      const response = await remote('https://oauth2.googleapis.com/token',{ method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ client_id:config.googleClientId, client_secret:config.googleClientSecret, code:params.get('code'), code_verifier:decrypt(state.verifier,config.key,`${provider}.state`), redirect_uri:callback(provider), grant_type:'authorization_code' }).toString() });
      if (!response.access_token || !response.refresh_token || !response.scope?.split(' ').includes(gmailScope)) throw new RequestError(400, 'Google did not grant the inbox permission or offline access. Connect again and accept the requested permission.');
      const profile = await remote('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${response.access_token}`}});
      if (profile.emailAddress?.toLowerCase() !== config.gmailEmail.toLowerCase()) throw new RequestError(400, 'Connect the configured business mailbox, rather than a different Google account');
      save(provider,profile.emailAddress,{accessToken:response.access_token,refreshToken:response.refresh_token,expiresAt:Date.now()+Number(response.expires_in ?? 3600)*1000},true);
    } else {
      const response = await remote(`https://${config.shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:config.shopifyClientId,client_secret:config.shopifyClientSecret,code:params.get('code')})});
      if (!response.access_token || !shopifyScopes.every(scope => response.scope?.split(',').includes(scope))) throw new RequestError(400, 'Shopify did not grant the requested order and product permissions');
      save(provider,config.shop,{accessToken:response.access_token,refreshToken:response.refresh_token,expiresAt:response.expires_in ? Date.now()+response.expires_in*1000 : null},true);
    }
    event(db,user,`Connected ${provider}`);
  }
  async function accessToken(provider) {
    const row = db.prepare('SELECT * FROM connections WHERE provider=?').get(provider);
    if (!row) throw new RequestError(409, 'Connect the account before syncing');
    const tokens = decrypt(row.encrypted_tokens,config.key,provider);
    if (!tokens.expiresAt || tokens.expiresAt > Date.now()+60000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new RequestError(409, 'Account access expired. Reconnect the account.');
    const response = provider === 'gmail'
      ? await remote('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.googleClientId,client_secret:config.googleClientSecret,refresh_token:tokens.refreshToken,grant_type:'refresh_token'}).toString()})
      : await remote(`https://${config.shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:config.shopifyClientId,client_secret:config.shopifyClientSecret,refresh_token:tokens.refreshToken,grant_type:'refresh_token'})});
    if (!response.access_token) throw new RequestError(502, 'Account access could not be refreshed');
    save(provider,row.account,{accessToken:response.access_token,refreshToken:response.refresh_token ?? tokens.refreshToken,expiresAt:Date.now()+Number(response.expires_in ?? 3600)*1000});
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
        const list = await remote('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=25',{headers});
        const items = (list.messages ?? []).slice(0,25);
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
        const data = await remote(`https://${config.shop}/admin/api/2026-10/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query:`query OperationsImport { orders(first:25,sortKey:UPDATED_AT,reverse:true) { nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } } } products(first:25,sortKey:UPDATED_AT,reverse:true) { nodes { id title handle status vendor } } }`})});
        if (data.errors?.length || !Array.isArray(data.data?.orders?.nodes) || !Array.isArray(data.data?.products?.nodes)) throw new RequestError(502, 'Shopify could not return orders and products. Check the app permissions and store access.');
        for (const order of data.data.orders.nodes) imported.push({id:order.id,type:'order',body:{title:order.name,date:order.createdAt,financialStatus:order.displayFinancialStatus,fulfillmentStatus:order.displayFulfillmentStatus,amount:order.totalPriceSet.shopMoney.amount,currency:order.totalPriceSet.shopMoney.currencyCode}});
        for (const product of data.data.products.nodes) imported.push({id:product.id,type:'product',body:{title:product.title,handle:product.handle,status:product.status,vendor:product.vendor}});
      }
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        // This is a bounded snapshot, not a full mailbox or store archive.
        db.prepare('DELETE FROM external_records WHERE provider=?').run(provider);
        for (const record of imported) db.prepare('INSERT INTO external_records(provider,external_id,type,body,synced_at) VALUES(?,?,?,?,?)').run(provider,record.id,record.type,JSON.stringify(record.body),now);
        db.prepare('UPDATE connections SET last_sync=? WHERE provider=?').run(now,provider);
        event(db,user,`Synced ${provider}: ${imported.length} records`);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      return { count:imported.length, syncedAt:now };
    } finally { active.delete(provider); }
  }
  async function handle({ path, req, body, user, sessionHash, json, res, url }) {
    if (!path.startsWith('/api/integrations')) return false;
    if (!user) throw new RequestError(401, 'Sign in required');
    if (req.method === 'GET' && path === '/api/integrations') { json(200,status()); return true; }
    if (req.method === 'GET' && path === '/api/integrations/records') {
      json(200,db.prepare('SELECT * FROM external_records ORDER BY provider,type,external_id').all().map(row => ({...row,body:JSON.parse(row.body)}))); return true;
    }
    const match = path.match(/^\/api\/integrations\/(gmail|shopify)\/(connect|callback|sync|disconnect)$/);
    if (!match) return false;
    const [,provider,action] = match;
    requireOwner(user);
    if (req.method === 'POST' && action === 'connect') { json(200,{url:begin(provider,user,sessionHash)}); return true; }
    if (req.method === 'GET' && action === 'callback') {
      await finish(provider,url.searchParams,user,sessionHash);
      res.writeHead(303,{Location:'/?view=connections'}); res.end(); return true;
    }
    if (req.method === 'POST' && action === 'sync') { json(200,await sync(provider,user)); return true; }
    if (req.method === 'POST' && action === 'disconnect') {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM connections WHERE provider=?').run(provider);
        db.prepare('DELETE FROM external_records WHERE provider=?').run(provider);
        db.prepare('DELETE FROM oauth_states WHERE provider=?').run(provider);
        event(db,user,`Disconnected ${provider}; provider-side permissions still require revocation`);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      json(200,{ok:true}); return true;
    }
    return false;
  }
  return { handle, status, begin, finish, sync };
}
