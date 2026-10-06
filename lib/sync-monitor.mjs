export function createSyncMonitor(db,integrations,{intervalSeconds=Number(process.env.OPS_SYNC_INTERVAL_SECONDS??0)}={}) {
  let active=false,stopped=false;
  async function tick() {
    if(active||stopped)return;active=true;
    try {
      const owner=db.prepare("SELECT id,username,role FROM users WHERE role='owner' ORDER BY id LIMIT 1").get();if(!owner)return;
      for(const connection of integrations.status().filter(item=>item.connected&&item.configured)) {
        try{const result=await integrations.sync(connection.provider,owner);db.prepare("INSERT INTO provider_health(provider,status,message,checked_at) VALUES(?,'ok',?,?) ON CONFLICT(provider) DO UPDATE SET status=excluded.status,message=excluded.message,checked_at=excluded.checked_at").run(connection.provider,`Synced ${result.count} records`,new Date().toISOString());}
        catch(error){db.prepare("INSERT INTO provider_health(provider,status,message,checked_at) VALUES(?,'error',?,?) ON CONFLICT(provider) DO UPDATE SET status=excluded.status,message=excluded.message,checked_at=excluded.checked_at").run(connection.provider,error.message,new Date().toISOString());}
      }
    }finally{active=false;}
  }
  let timer;
  if(Number.isFinite(intervalSeconds)&&intervalSeconds>=60){timer=setInterval(()=>tick().catch(()=>{}),intervalSeconds*1000);timer.unref();}
  return {tick,status:()=>({enabled:!!timer,intervalSeconds:timer?intervalSeconds:0,providers:db.prepare('SELECT * FROM provider_health').all()}),stop:()=>{stopped=true;if(timer)clearInterval(timer);}};
}
