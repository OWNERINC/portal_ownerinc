import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import https from 'node:https';
import { generateKeyPairSync,sign } from 'node:crypto';
import { once } from 'node:events';
import { fixtureIdentity } from '../../scripts/integration/payload-functional-fixture.mjs';
import { observeFunctionalNginxTarget,functionalNginxVerifier,reserveFunctionalForwarder }
  from '../../scripts/integration/payload-functional-forwarder.mjs';
import { assertNoPublishedPorts } from '../../scripts/integration/payload-functional-isolation.mjs';
import { httpsFixtureClient } from '../../scripts/integration/payload-functional-http.mjs';
import { assertFunctionalHTTPSReadiness } from '../../scripts/integration/payload-functional-readiness.mjs';

const identity=fixtureIdentity('134cfd81-7f0d-47ca-a4fb-c9cabd069c0f'),imageId='sha256:'+'a'.repeat(64);
function inspected() {
  const containerId='b'.repeat(64),networkId='c'.repeat(64),endpointId='d'.repeat(64),name=`${identity.project}-network`;
  const network={Name:name,Id:networkId,Driver:'bridge',Scope:'local',Internal:true,Options:{},EnableIPv6:false,
    Labels:{'com.docker.compose.project':identity.project,'ownerinc.functional.run':identity.runId,'ownerinc.functional.role':'network'},
    IPAM:{Config:[{Subnet:'172.29.0.0/16',Gateway:'172.29.0.1'}]},
    Containers:{[containerId]:{Name:identity.containers.nginx,EndpointID:endpointId,IPv4Address:'172.29.0.9/16'}}};
  const container={Id:containerId,Name:'/'+identity.containers.nginx,Image:imageId,State:{Running:true},
    Config:{Labels:{'com.docker.compose.project':identity.project,'ownerinc.functional.run':identity.runId,'ownerinc.functional.role':'nginx'}},
    HostConfig:{NetworkMode:name,PortBindings:{},PublishAllPorts:false},
    NetworkSettings:{Ports:{'80/tcp':null},Networks:{[name]:{NetworkID:networkId,EndpointID:endpointId,
      IPAddress:'172.29.0.9',IPPrefixLen:16,Gateway:'',GlobalIPv6Address:''}}}};
  return {network,container};
}

test('Nginx destination comes only from running lease-bound container/internal-network inspections (Docker observations double)',()=>{
  const {network,container}=inspected(),target=observeFunctionalNginxTarget(identity,network,container,imageId);
  assert.equal(target.address,'172.29.0.9');assert.equal(target.port,443);assert.equal(target.runId,identity.runId);
  for(const address of ['127.0.0.1','169.254.169.254','8.8.8.8','172.29.0.1','172.29.0.0','172.29.255.255',
    '172.30.0.8','172.29.000.8','localhost','external.invalid','https://private.invalid']) {
    const changed=structuredClone(container);changed.NetworkSettings.Networks[network.Name].IPAddress=address;
    assert.throws(()=>observeFunctionalNginxTarget(identity,network,changed,imageId));
  }
  for(const mutate of [value=>{value.container.State.Running=false;},value=>{value.container.Id='e'.repeat(64);},
    value=>{value.network.Internal=false;},value=>{value.network.Containers[value.container.Id].EndpointID='e'.repeat(64);},
    value=>{value.container.NetworkSettings.Networks.egress={NetworkID:'e'.repeat(64)};},
    value=>{value.network.Containers['e'.repeat(64)]={Name:'uncontrolled-container'};}]) {
    const value=inspected();mutate(value);assert.throws(()=>observeFunctionalNginxTarget(identity,value.network,value.container,imageId));
  }
});

test('effective Docker Ports are checked, not just desired HostConfig.PortBindings',()=>{
  const {container}=inspected();assertNoPublishedPorts(container);
  for(const change of [
    {HostConfig:{...container.HostConfig,PortBindings:{'443/tcp':[{HostIp:'127.0.0.1',HostPort:'19443'}]}}},
    {HostConfig:{...container.HostConfig,PublishAllPorts:true}},
    {NetworkSettings:{...container.NetworkSettings,Ports:{'443/tcp':[{HostIp:'0.0.0.0',HostPort:'19443'}]}}},
    {NetworkSettings:{...container.NetworkSettings,Ports:{'443/tcp':[]}}},
  ]) assert.throws(()=>assertNoPublishedPorts({...container,...change}),{code:'functional_unexpected_published_port'});
});

test('verifier re-inspects exact lease resource names and rejects replacement/IP changes (Docker double)',async()=>{
  let value=inspected();const calls=[];
  const docker=async args=>{
    calls.push(args);return JSON.stringify([args[0]==='network' ? value.network : value.container]);
  };
  const verify=functionalNginxVerifier(identity,docker,imageId);
  await verify();await verify();
  assert.deepEqual(calls.slice(0,2),[['network','inspect',`${identity.project}-network`],['inspect',identity.containers.nginx]]);
  value.container.NetworkSettings.Networks[value.network.Name].IPAddress='172.29.0.10';
  value.network.Containers[value.container.Id].IPv4Address='172.29.0.10/16';
  await assert.rejects(verify(),{code:'functional_forwarder_target_changed'});
});

async function backend(t,onConnection=socket=>socket.pipe(socket)) {
  const connections=new Set(),server=net.createServer(socket=>{
    connections.add(socket);socket.on('error',()=>{});socket.once('close',()=>connections.delete(socket));onConnection(socket);
  });
  await new Promise(resolve=>server.listen({host:'127.0.0.1',port:0,exclusive:true},resolve));
  t.after(async()=>{for(const socket of connections) socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return server.address().port;
}
const open=async port=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});await once(socket,'connect');return socket;};
const target=()=>{const {network,container}=inspected();return observeFunctionalNginxTarget(identity,network,container,imageId);};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('real loopback forwarder transports bytes/half-close to synthetic TCP backend; private-IP dial remap is an explicit unit seam',async t=>{
  const port=await backend(t,socket=>{socket.on('data',chunk=>socket.write(chunk));socket.on('end',()=>socket.end());});
  const dials=[];let verifies=0;
  const forwarder=await reserveFunctionalForwarder({},options=>{
    dials.push(options);return net.createConnection({...options,host:'127.0.0.1',port});
  });
  t.after(()=>forwarder.stop());
  const listener=forwarder.assertHealthy();assert.equal(listener.address,'127.0.0.1');assert.equal(listener.pid,process.pid);
  assert.equal(new URL(forwarder.origin).port,String(listener.port));assert.notEqual(listener.port,port);
  await forwarder.activate(async()=>{verifies++;return target();});
  const socket=await open(forwarder.port);t.after(()=>socket.destroy());
  const data=once(socket,'data');socket.write('synthetic TCP unit payload');
  assert.equal((await data)[0].toString(),'synthetic TCP unit payload');
  assert.deepEqual(dials[0],{host:'172.29.0.9',port:443,family:4,allowHalfOpen:true});assert.equal(verifies,2);
  const closed=once(socket,'close');socket.end();await closed;
  await forwarder.recheck();assert.equal(verifies,3);
  await forwarder.stop();assert.throws(()=>forwarder.assertHealthy(),{code:'functional_forwarder_listener_closed'});
  await assert.rejects(open(forwarder.port),/ECONNREFUSED/);
});

test('listener is reserved atomically on port 0, accepts no traffic before activation and no caller URL/port override',async t=>{
  let dials=0;const forwarder=await reserveFunctionalForwarder({},()=>{dials++;throw new Error('must not dial');});
  t.after(()=>forwarder.stop());
  const socket=await open(forwarder.port);const closed=once(socket,'close');await closed;assert.equal(dials,0);
  await assert.rejects(new Promise((resolve,reject)=>{
    const other=net.createServer();other.once('error',reject);
    other.listen({host:'127.0.0.1',port:forwarder.port,exclusive:true},()=>other.close(resolve));
  }),/EADDRINUSE/);
  for(const options of [{host:'0.0.0.0'},{port:19443},{target:'https://external.invalid'},{maxConnections:33}])
    await assert.rejects(reserveFunctionalForwarder(options),{code:'functional_forwarder_limits_invalid'});
  for(const address of ['127.0.0.1','169.254.169.254','external.invalid'])
    await assert.rejects(forwarder.activate(async()=>({...target(),address})),{code:'functional_forwarder_target_invalid'});
});

test('binding drift closes real listener/sockets before another upstream dial (unit inspection/dial seams)',async t=>{
  const port=await backend(t);let calls=0,dials=0;
  const forwarder=await reserveFunctionalForwarder({},()=>{dials++;return net.createConnection({host:'127.0.0.1',port});});
  t.after(()=>forwarder.stop());
  await forwarder.activate(async()=>++calls===1 ? target() : {...target(),networkId:'e'.repeat(64)});
  const socket=await open(forwarder.port);await once(socket,'close');await forwarder.stop();
  assert.equal(dials,0);assert.throws(()=>forwarder.assertHealthy(),{code:'functional_forwarder_binding_failed'});
});

test('hung target inspection and lifetime expiry are bounded and close the real listener (unit verifier double)',async t=>{
  const forwarder=await reserveFunctionalForwarder({recheckTimeout:25});t.after(()=>forwarder.stop());
  let calls=0;await forwarder.activate(async()=>++calls===1 ? target() : new Promise(()=>{}));
  const socket=await open(forwarder.port);await once(socket,'close');await forwarder.stop();
  assert.throws(()=>forwarder.assertHealthy(),{code:'functional_forwarder_binding_failed'});
  const expiring=await reserveFunctionalForwarder({lifetime:25});t.after(()=>expiring.stop());
  await wait(50);assert.throws(()=>expiring.assertHealthy(),{code:'functional_forwarder_lifetime_exceeded'});
});

test('real sockets enforce byte, idle and connection-count limits against synthetic backend (dial seam)',async t=>{
  const port=await backend(t);let dials=0;
  const forwarder=await reserveFunctionalForwarder({byteLimit:16,idleTimeout:100,maxConnections:1},()=>{
    dials++;return net.createConnection({host:'127.0.0.1',port});
  });t.after(()=>forwarder.stop());await forwarder.activate(async()=>target());
  const first=await open(forwarder.port);t.after(()=>first.destroy());
  const second=await open(forwarder.port);await once(second,'close');
  const closed=once(first,'close');first.write('this exceeds the synthetic unit byte bound');await closed;
  assert.equal(dials,1);
  const idle=await open(forwarder.port);await once(idle,'close');assert.equal(dials,2);
});

// Generate a throwaway self-signed test CA/certificate in memory, without openssl,
// stored private keys or a dependency. DER is limited to this synthetic unit cert.
function syntheticTLS() {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const der=(tag,...parts)=>{
    const body=Buffer.concat(parts),length=body.length;
    const encoded=length<128 ? Buffer.from([length]) : length<256 ? Buffer.from([0x81,length]) : Buffer.from([0x82,length>>8,length&255]);
    return Buffer.concat([Buffer.from([tag]),encoded,body]);
  };
  const sequence=(...parts)=>der(0x30,...parts),oid=hex=>der(6,Buffer.from(hex,'hex'));
  const algorithm=sequence(oid('2a864886f70d01010b'),der(5));
  const name=sequence(der(0x31,sequence(oid('550403'),der(12,Buffer.from('synthetic-forwarder-unit')))));
  const extensions=der(0xa3,sequence(
    sequence(oid('551d13'),der(1,Buffer.from([255])),der(4,sequence(der(1,Buffer.from([255]))))),
    sequence(oid('551d11'),der(4,sequence(der(0x87,Buffer.from([127,0,0,1]))))),
  ));
  const tbs=sequence(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),algorithm,name,
    sequence(der(0x18,Buffer.from('20200101000000Z')),der(0x18,Buffer.from('20400101000000Z'))),
    name,publicKey.export({type:'spki',format:'der'}),extensions);
  const certDER=sequence(tbs,algorithm,der(3,Buffer.from([0]),sign('sha256',tbs,privateKey)));
  const cert='-----BEGIN CERTIFICATE-----\n'+certDER.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
  return {cert,key:privateKey.export({type:'pkcs8',format:'pem'})};
}

test('real HTTPS readiness traverses real host listener and TLS terminates only at synthetic backend (not Docker; dial remap seam)',async t=>{
  const tls=syntheticTLS(),paths=[],hosts=[];
  let ready=true;
  const server=https.createServer(tls,(req,res)=>{
    paths.push(req.url);hosts.push(req.headers.host);res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({status:ready ? 'ready' : 'not_ready'}));
  });
  server.on('tlsClientError',()=>{});
  await new Promise(resolve=>server.listen({host:'127.0.0.1',port:0},resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const port=server.address().port;
  const forwarder=await reserveFunctionalForwarder({},options=>net.createConnection({...options,host:'127.0.0.1',port}));
  t.after(()=>forwarder.stop());await forwarder.activate(async()=>target());
  const client=httpsFixtureClient(forwarder.origin,tls.cert);
  assert.deepEqual(await assertFunctionalHTTPSReadiness(client,forwarder),{listenerObserved:true,tlsVerifiedReadiness:true});
  assert.deepEqual(paths,['/api/ready','/editorial/ready']);assert.ok(hosts.every(host=>host===`127.0.0.1:${forwarder.port}`));
  await assert.rejects(httpsFixtureClient(forwarder.origin,syntheticTLS().cert)('/api/ready'),/functional_https_transport_failed/);
  ready=false;
  await assert.rejects(assertFunctionalHTTPSReadiness(client,forwarder,{timeout:40,interval:5}),{code:'functional_real_readiness_timeout'});
  await forwarder.stop();forwarder.assertStopped();
  await assert.rejects(assertFunctionalHTTPSReadiness(client,forwarder),{code:'functional_forwarder_listener_closed'});
});

test('readiness does not accept desired origin/port claims, missing API/CMS readiness, redirects or headings (unit HTTP double)',async t=>{
  const forwarder=await reserveFunctionalForwarder();t.after(()=>forwarder.stop());await forwarder.activate(async()=>target());
  const falseBinding={...forwarder,port:forwarder.port+1};
  await assert.rejects(assertFunctionalHTTPSReadiness(async()=>({status:200,json:{status:'ready'}}),falseBinding),
    {code:'functional_runtime_listener_binding_invalid'});
  for(const response of [{status:302,json:{status:'ready'}},{status:200,json:{title:'Admin'}},{status:503,json:{status:'ready'}}]) {
    await assert.rejects(assertFunctionalHTTPSReadiness(async()=>response,forwarder,{timeout:20,interval:5}),{code:'functional_real_readiness_timeout'});
  }
  const paths=[];
  await assert.rejects(assertFunctionalHTTPSReadiness(async pathname=>{
    paths.push(pathname);return {status:pathname==='/api/ready' ? 200 : 503,json:{status:'ready'}};
  },forwarder,{timeout:20,interval:5}),{code:'functional_real_readiness_timeout'});
  assert.ok(paths.includes('/editorial/ready'));
});
