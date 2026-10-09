import { IntegrationGuardError } from '../../cms/tests/support/integration-config.mjs';

export async function assertFunctionalHTTPSReadiness(client,forwarder,{timeout=180000,interval=1000}={}) {
  if(!Number.isInteger(timeout) || timeout<1 || timeout>180000 || !Number.isInteger(interval) || interval<1 || interval>1000) {
    throw new IntegrationGuardError('functional_readiness_limits_invalid');
  }
  const deadline=Date.now()+timeout;
  const listener=()=>{
    const actual=forwarder.assertHealthy();
    if(actual.address!=='127.0.0.1' || actual.pid!==process.pid || actual.port!==forwarder.port ||
      forwarder.origin!==`https://127.0.0.1:${actual.port}`) throw new IntegrationGuardError('functional_runtime_listener_binding_invalid');
  };
  listener();await forwarder.recheck();
  for(const pathname of ['/api/ready','/editorial/ready']) {
    let ready=false;
    while(Date.now()<deadline) {
      listener();
      try {
        const response=await client(pathname,{timeout:Math.min(5000,Math.max(1,deadline-Date.now()))});
        if(response.status===200 && response.json?.status==='ready') {ready=true;break;}
      } catch {}
      await new Promise(resolve=>setTimeout(resolve,Math.min(interval,Math.max(1,deadline-Date.now()))));
    }
    if(!ready) throw new IntegrationGuardError('functional_real_readiness_timeout');
    await forwarder.recheck();listener();
  }
  return {listenerObserved:true,tlsVerifiedReadiness:true};
}
