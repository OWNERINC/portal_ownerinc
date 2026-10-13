// Runner-owned TCP only. TLS terminates in Nginx; never an HTTP/CONNECT proxy.
import net from 'node:net';
import { IntegrationGuardError } from '../../cms/tests/support/integration-config.mjs';
import { assertContainerBinding } from './payload-functional-targets.mjs';
import { assertFixtureNetwork,assertContainerNetwork,assertNoPublishedPorts } from './payload-functional-isolation.mjs';

const refuse=code=>{throw new IntegrationGuardError(code);};
const ipv4=value=>net.isIP(value)===4 && value.split('.').every(part=>String(Number(part))===part);
const integer=value=>value.split('.').reduce((number,part)=>number*256+Number(part),0);
const privateIP=value=>ipv4(value) && (value.startsWith('10.') || value.startsWith('192.168.') ||
  value.startsWith('172.') && Number(value.split('.')[1])>=16 && Number(value.split('.')[1])<=31);

export function observeFunctionalNginxTarget(identity,network,container,imageId) {
  assertFixtureNetwork(identity,network);
  assertContainerBinding(identity,'nginx',container,imageId);
  assertContainerNetwork(identity,container,network.Id);
  assertNoPublishedPorts(container);
  const endpoint=container.NetworkSettings.Networks[network.Name],ranges=network.IPAM?.Config;
  if(!/^sha256:[0-9a-f]{64}$/.test(imageId) || !/^[0-9a-f]{64}$/.test(container.Id || '') || container.State?.Running!==true ||
    network.EnableIPv6===true || !Array.isArray(ranges) || ranges.length!==1) refuse('functional_forwarder_target_invalid');
  const [subnet,prefixText]=(ranges[0].Subnet || '').split('/'),prefix=Number(prefixText),address=endpoint.IPAddress;
  const gateway=ranges[0].Gateway;
  if(!privateIP(subnet) || !/^(?:1[6-9]|2[0-9]|30)$/.test(prefixText || '') || !privateIP(address) || !privateIP(gateway) ||
    endpoint.IPPrefixLen!==prefix || address===gateway || endpoint.GlobalIPv6Address ||
    endpoint.Gateway && endpoint.Gateway!==gateway) refuse('functional_forwarder_target_invalid');
  const size=2**(32-prefix),base=integer(subnet),ip=integer(address);
  if(base%size!==0 || ip<=base || ip>=base+size-1 || integer(gateway)<=base || integer(gateway)>=base+size-1) {
    refuse('functional_forwarder_target_invalid');
  }
  const member=network.Containers?.[container.Id];
  if(!/^[0-9a-f]{64}$/.test(endpoint.EndpointID || '') || member?.Name!==identity.containers.nginx ||
    member.EndpointID!==endpoint.EndpointID || member.IPv4Address!==`${address}/${prefix}` ||
    Object.values(network.Containers).some(value=>!Object.values(identity.containers).includes(value.Name))) {
    refuse('functional_forwarder_target_invalid');
  }
  return Object.freeze({runId:identity.runId,containerId:container.Id,networkId:network.Id,imageId,address,port:443});
}

export function functionalNginxVerifier(identity,docker,imageId) {
  let pinned;
  return async()=>{
    const [network,container]=await Promise.all([
      docker(['network','inspect',`${identity.project}-network`]),docker(['inspect',identity.containers.nginx]),
    ]);
    let target;
    try {target=observeFunctionalNginxTarget(identity,JSON.parse(network)[0],JSON.parse(container)[0],imageId);}
    catch {refuse('functional_forwarder_target_invalid');}
    if(pinned && JSON.stringify(pinned)!==JSON.stringify(target)) refuse('functional_forwarder_target_changed');
    pinned=target;return target;
  };
}

const bounds=Object.freeze({maxConnections:32,idleTimeout:15000,connectionTimeout:5000,recheckTimeout:5000,
  connectionLifetime:60000,lifetime:1800000,byteLimit:16*1024*1024});
const bounded=async(work,timeout)=>{
  let timer;
  try {return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new IntegrationGuardError('functional_forwarder_recheck_timeout')),timeout);
  })]);} finally {clearTimeout(timer);}
};

// The second argument is a socket-dial test seam, not a lease/env/CLI setting.
// Production always uses net.createConnection to the inspected private IP:443.
export async function reserveFunctionalForwarder(options={},dial=net.createConnection) {
  if(Object.keys(options).some(key=>!Object.hasOwn(bounds,key)) || Object.entries({...bounds,...options})
    .some(([key,value])=>!Number.isInteger(value) || value<1 || value>bounds[key])) refuse('functional_forwarder_limits_invalid');
  const limits={...bounds,...options},sockets=new Set(),upstreams=new Set();
  let verify,pinned,failure,stopped=false,closing,lifetimeTimer;
  const server=net.createServer({pauseOnConnect:true,allowHalfOpen:true},socket=>{
    if(stopped || !verify || socket.remoteAddress!=='127.0.0.1' || sockets.size>=limits.maxConnections) {socket.destroy();return;}
    sockets.add(socket);
    let upstream,bytes=0,connectTimer;
    const end=()=>{clearTimeout(connectTimer);clearTimeout(totalTimer);socket.destroy();upstream?.destroy();};
    const totalTimer=setTimeout(end,limits.connectionLifetime);
    socket.setTimeout(limits.idleTimeout,end);socket.on('error',end);
    socket.once('close',()=>{sockets.delete(socket);end();});
    const count=chunk=>{bytes+=chunk.length;if(bytes>limits.byteLimit) end();};
    void bounded(verify,limits.recheckTimeout).then(target=>{
      if(stopped || socket.destroyed) return;
      if(JSON.stringify(target)!==JSON.stringify(pinned)) refuse('functional_forwarder_target_changed');
      upstream=dial({host:pinned.address,port:443,family:4,allowHalfOpen:true});
      upstreams.add(upstream);upstream.once('close',()=>upstreams.delete(upstream));
      connectTimer=setTimeout(end,limits.connectionTimeout);
      upstream.on('error',end);upstream.setTimeout(limits.idleTimeout,end);
      upstream.once('close',end);
      upstream.once('connect',()=>{
        clearTimeout(connectTimer);
        socket.on('data',count);upstream.on('data',count);
        socket.pipe(upstream);upstream.pipe(socket);socket.resume();
      });
    }).catch(()=>{failure='functional_forwarder_binding_failed';end();void stop();});
  });
  server.maxConnections=limits.maxConnections;
  server.on('error',()=>{failure='functional_forwarder_listener_failed';void stop();});
  const stop=()=>{
    if(closing) return closing;
    stopped=true;clearTimeout(lifetimeTimer);
    // server.close can settle before socket 'close' callbacks. Await the actual
    // close of both accepted and upstream sockets, not just a desired state.
    const closed=[...sockets,...upstreams].map(socket=>new Promise(resolve=>{
      socket.once('close',resolve);socket.destroy();
    }));
    closed.push(new Promise(resolve=>{if(server.listening) server.close(()=>resolve());else resolve();}));
    closing=Promise.all(closed).then(()=>{});
    return closing;
  };
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(new IntegrationGuardError('functional_forwarder_listener_failed')));
    server.listen({host:'127.0.0.1',port:0,exclusive:true,backlog:limits.maxConnections},resolve);
  });
  const address=server.address();
  if(address?.address!=='127.0.0.1' || address.family!=='IPv4' || address.port<1024) {await stop();refuse('functional_forwarder_listener_invalid');}
  const port=address.port,origin=`https://127.0.0.1:${port}`;
  lifetimeTimer=setTimeout(()=>{failure='functional_forwarder_lifetime_exceeded';void stop();},limits.lifetime);
  const assertHealthy=()=>{
    const actual=server.address();
    if(failure || stopped || !server.listening || actual?.address!=='127.0.0.1' || actual.port!==port) {
      refuse(failure || 'functional_forwarder_listener_closed');
    }
    return {address:actual.address,port:actual.port,pid:process.pid};
  };
  return Object.freeze({port,origin,pid:process.pid,assertHealthy,stop,
    assertStopped() {if(!stopped || server.listening || sockets.size || upstreams.size) refuse('functional_forwarder_still_running');},
    async activate(verifier) {
      assertHealthy();
      if(verify || typeof verifier!=='function') refuse('functional_forwarder_already_bound');
      const target=await bounded(verifier,limits.recheckTimeout);
      if(!privateIP(target?.address) || target.port!==443 || !/^[0-9a-f]{64}$/.test(target.containerId || '') ||
        !/^[0-9a-f]{64}$/.test(target.networkId || '') || !/^sha256:[0-9a-f]{64}$/.test(target.imageId || '') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.runId || '')) refuse('functional_forwarder_target_invalid');
      pinned=Object.freeze({...target});verify=verifier;assertHealthy();return pinned;
    },
    async recheck() {
      try {
        assertHealthy();if(!verify) refuse('functional_forwarder_not_bound');
        const target=await bounded(verify,limits.recheckTimeout);
        if(JSON.stringify(target)!==JSON.stringify(pinned)) refuse('functional_forwarder_target_changed');
        assertHealthy();return pinned;
      } catch(error) {failure='functional_forwarder_binding_failed';await stop();throw error;}
    },
  });
}
