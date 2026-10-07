// Read retries cannot send, modify or delete mail. Serialize the metadata batches
// so concurrent callers share one rate budget instead of bursting against Gmail.
export function createGmailReader(fetcher,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,intervalMs=250,maxRetries=7}={}) {
  let queue=Promise.resolve(),nextAt=0;
  async function attempt(url,options) {
    for(let retry=0;;retry++) {
      await sleep(Math.max(0,nextAt-now()));
      nextAt=now()+intervalMs;
      const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
      if(response.ok)return response;
      let reason;try{const body=await response.clone().json();reason=body.error?.errors?.map(error=>error.reason)??[];}catch{reason=[];}
      const limited=response.status===429||(response.status===403&&reason.some(value=>['rateLimitExceeded','userRateLimitExceeded'].includes(value)));
      if(!limited)return response;
      if(retry>=maxRetries)return new Response('{}',{status:429,headers:{'Content-Type':'application/json'}});
      const retryAfter=Number(response.headers.get('retry-after'));
      await sleep(Math.min(60000,Math.max(1000*2**retry,Number.isFinite(retryAfter)?retryAfter*1000:0)));
    }
  }
  return (url,options={})=>{
    if(new URL(url).origin!=='https://gmail.googleapis.com'||(options.method??'GET')!=='GET')throw new Error('Gmail read retry accepts only Gmail GET requests');
    const result=queue.then(()=>attempt(url,options));queue=result.catch(()=>{});return result;
  };
}
