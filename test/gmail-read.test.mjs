import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGmailReader} from '../lib/gmail-read.mjs';
const limited=()=>new Response(JSON.stringify({error:{errors:[{reason:'rateLimitExceeded'}]}}),{status:403});
test('Gmail quota retries serialize reads, back off, and preserve true permission errors',async()=>{
  let clock=0,calls=0,active=0,maxActive=0;const waits=[];
  const read=createGmailReader(async()=>{active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;return ++calls===1?limited():new Response('{}');},{now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});
  const results=await Promise.all([read('https://gmail.googleapis.com/a'),read('https://gmail.googleapis.com/b')]);
  assert.ok(results.every(response=>response.ok));assert.equal(calls,3);assert.equal(maxActive,1);assert.ok(waits.includes(1000));assert.ok(waits.includes(250));
  let deniedCalls=0;const denied=createGmailReader(async()=>{deniedCalls++;return new Response('{}',{status:403});},{sleep:async()=>{}});
  assert.equal((await denied('https://gmail.googleapis.com/a')).status,403);assert.equal(deniedCalls,1);
  assert.throws(()=>read('https://gmail.googleapis.com/a',{method:'POST'}),/only Gmail GET/);
  assert.throws(()=>read('https://example.test/a'),/only Gmail GET/);
});
test('persistent Gmail rate limits become a pause rather than a reconnect instruction',async()=>{
  let calls=0;const read=createGmailReader(async()=>{calls++;return limited();},{sleep:async()=>{},maxRetries:2});
  assert.equal((await read('https://gmail.googleapis.com/a')).status,429);assert.equal(calls,3);
});
