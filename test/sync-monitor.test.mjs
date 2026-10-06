import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore,addUser} from '../lib/store.mjs';
import {createSyncMonitor} from '../lib/sync-monitor.mjs';
test('background read-only sync is configurable, non-overlapping, and records provider failures without losing status',async()=>{
  const db=openStore(':memory:');addUser(db,'owner','sync-monitor-password');let calls=0,resolve;
  const service={status:()=>[{provider:'gmail',connected:true,configured:true},{provider:'shopify',connected:true,configured:true}],sync:async provider=>{calls++;if(provider==='gmail'){await new Promise(r=>resolve=r);return {count:2};}throw new Error('Provider access denied');}};
  const monitor=createSyncMonitor(db,service,{intervalSeconds:0});
  try{assert.equal(monitor.status().enabled,false);const tick=monitor.tick();await monitor.tick();assert.equal(calls,1);resolve();await tick;assert.equal(calls,2);assert.deepEqual(monitor.status().providers.map(p=>p.status),['ok','error']);}
  finally{monitor.stop();db.close();}
});
