import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, stat, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createFixtureProjectNames, createInventory } from '../../scripts/integration/payload-preauthority-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { extractSmokeFailure, FIXTURE_SMOKE_CONTEXT } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';

// Test-only native supervisor. No dependency, helper file, HTTP change or rm
// retry: create suspended -> assign to a non-breakaway Job -> resume. The stable
// Job handle owns descendants even after spawnSync kills their direct parent.
const windowsJobSource=String.raw`
using System;
using System.Text;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
public static class OwnedSmokeTree {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint Flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential)] struct Port { public IntPtr key,handle; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int cb; public string reserved,desktop,title; public uint x,y,w,h,cx,cy,fill,flags; public ushort show,reserved2; public IntPtr bytes,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting data,uint length,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr port,UIntPtr key,uint threads);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out UIntPtr key,out IntPtr data,uint ms);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok,string operation) { if(!ok) throw new Exception(operation+":"+Marshal.GetLastWin32Error()); }
 static void Set<T>(IntPtr job,int type,T value) { IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); try { Marshal.StructureToPtr(value,p,false); Check(SetInformationJobObject(job,type,p,(uint)Marshal.SizeOf(typeof(T))),"job_config"); } finally { Marshal.FreeHGlobal(p); } }
 static uint Active(IntPtr job) { Accounting a; Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"job_accounting"); return a.active; }
 public static int Run(string exe,string cmd,string cwd,string pipe,bool inject) {
  IntPtr job=IntPtr.Zero,port=IntPtr.Zero,witness=IntPtr.Zero; ProcessInfo pi=new ProcessInfo(); bool assigned=false,closing=false; int cancelled=0,witnessed=0; object sync=new object();
  try {
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"job_create");
   Limits limits=new Limits(); limits.basic.Flags=0x2000; Set(job,9,limits); // KILL_ON_JOB_CLOSE; NO breakaway permissions.
   port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,UIntPtr.Zero,1); Check(port!=IntPtr.Zero,"job_port");
   Port association=new Port(); association.key=new IntPtr(1); association.handle=port; Set(job,7,association);
   using(NamedPipeServerStream control=new NamedPipeServerStream(pipe,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous)) {
    control.BeginWaitForConnection(delegate(IAsyncResult ar) {
     try { control.EndWaitForConnection(ar); using(StreamReader reader=new StreamReader(control)) using(StreamWriter writer=new StreamWriter(control)) {
      writer.AutoFlush=true; string line=reader.ReadLine();
      if(line=="cancel") lock(sync) { if(!closing) { Check(TerminateJobObject(job,143),"job_cancel"); cancelled=1; } }
      else if(line!=null && line.StartsWith("witness ")) lock(sync) {
       uint pid; bool witnessMember=false; IntPtr handle=IntPtr.Zero;
       if(uint.TryParse(line.Substring(8),out pid)) handle=OpenProcess(0x101000,false,pid);
       bool ok=!closing && handle!=IntPtr.Zero && WaitForSingleObject(pi.process,0)==258 && WaitForSingleObject(handle,0)==258
         && IsProcessInJob(handle,job,out witnessMember) && witnessMember && Active(job)>=2;
       if(ok) { witness=handle; witnessed=1; writer.WriteLine("owned-live"); }
       else { if(handle!=IntPtr.Zero)CloseHandle(handle);writer.WriteLine("ownership-unproven"); }
      }
     } }
     catch(ObjectDisposedException) {} catch(IOException) {} // Normal disposal of the waiting control pipe.
    },null);
    Startup si=new Startup(); si.cb=Marshal.SizeOf(typeof(Startup)); si.flags=0x100;
    si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
    Check(SetHandleInformation(si.input,1,1)&&SetHandleInformation(si.output,1,1)&&SetHandleInformation(si.error,1,1),"stdio_inherit");
    Check(CreateProcess(exe,new StringBuilder(cmd),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,cwd,ref si,out pi),"root_create_suspended");
    Check(AssignProcessToJobObject(job,pi.process),"root_assign"); assigned=true;
    bool rootMember; Check(IsProcessInJob(pi.process,job,out rootMember)&&rootMember,"root_membership");
    Check(ResumeThread(pi.thread)!=0xffffffff,"root_resume");
    Check(WaitForSingleObject(pi.process,180000)==0,"root_wait");
    uint exit; Check(GetExitCodeProcess(pi.process,out exit),"root_exit");
    uint descendantExit=0; bool descendantAlive=witness!=IntPtr.Zero && WaitForSingleObject(witness,0)==258;
    if(witness!=IntPtr.Zero)Check(GetExitCodeProcess(witness,out descendantExit),"witness_exit_status");
    uint before=Active(job);
    lock(sync) { closing=true; Check(TerminateJobObject(job,137),"job_finish"); }
    Stopwatch bound=Stopwatch.StartNew();
    while(Active(job)!=0) {
     int left=10000-(int)bound.ElapsedMilliseconds; if(left<=0) throw new Exception("owned_tree_exit_timeout");
     uint message; UIntPtr key; IntPtr data;
     Check(GetQueuedCompletionStatus(port,out message,out key,out data,(uint)left),"owned_tree_exit_event");
    }
    if(witness!=IntPtr.Zero)Check(WaitForSingleObject(witness,10000)==0,"witness_terminated");
    Console.Error.WriteLine("OWNED_TEST_TREE root="+pi.pid+" assigned=1 activeBefore="+before+" activeAfter=0 cancelled="+cancelled+" rootExit="+exit+" injected="+(inject?1:0)+" witnessed="+witnessed+" descendantAliveAfterRoot="+(descendantAlive?1:0)+" descendantExitBeforeCleanup="+descendantExit);
    return inject?66:(int)exit; // Reporting-failure injection only AFTER verified termination.
   }
  } finally {
   lock(sync) { closing=true; }
   if(pi.process!=IntPtr.Zero && !assigned) { TerminateProcess(pi.process,137); WaitForSingleObject(pi.process,10000); }
   if(job!=IntPtr.Zero) CloseHandle(job); // Stable owned handle, never name/PID-based process killing.
   if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process); if(port!=IntPtr.Zero) CloseHandle(port);
   if(witness!=IntPtr.Zero)CloseHandle(witness);
  }
 }
}
`;

const posixDriverBarrier=String.raw`
if(process.send) {
  process.on('message',()=>{}); // Retain the known leader/PGID until owned teardown.
  await new Promise(resolve=>process.stdout.write('\n',resolve));
  process.send({ownedReady:true,pid:process.pid,bodyCode:process.exitCode||0});
  await new Promise(()=>{});
}
`;

function windowsQuote(value) { return '"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/g,'$1$1')+'"'; }

async function ownedTestProcess(command,args,{env=process.env,cwd=process.cwd(),driver=false,onSpawn,ledger,injectCleanupFailure=false}={}) {
  let stdout='',stderr='';
  const record={assignedBeforeResume:false,activeAfter:null}; ledger?.push(record);
  if(process.platform==='win32') {
    const pipe='owned-smoke-'+randomUUID();
    const b64=value=>Buffer.from(value,'utf8').toString('base64');
    const decode=value=>`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(value)}'))`;
    const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (${decode(windowsJobSource)}) -ErrorAction Stop; $code=[OwnedSmokeTree]::Run((${decode(command)}),(${decode([command,...args].map(windowsQuote).join(' '))}),(${decode(cwd)}),'${pipe}',$${injectCleanupFailure?'true':'false'}); exit $code\n`;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','-'],{env:{...env,OWNED_TEST_CONTROL_PIPE:pipe},cwd,stdio:['pipe','pipe','pipe']});
    child.stdout.on('data',data=>{stdout+=data;}); child.stderr.on('data',data=>{stderr+=data;});
    onSpawn?.({kill:signal=>{
      assert.equal(signal,'SIGTERM');
      const control=createConnection(`\\\\.\\pipe\\${pipe}`);
      control.on('error',()=>{}); // Missing ownership proof still fails below, never a cleanup fallback.
      control.on('connect',()=>control.end('cancel\n'));
      return true;
    }});
    child.stdin.end(script);
    const [code,signal]=await once(child,'close');
    const match=stderr.match(/^OWNED_TEST_TREE root=(\d+) assigned=1 activeBefore=(\d+) activeAfter=0 cancelled=([01]) rootExit=(\d+) injected=([01]) witnessed=([01]) descendantAliveAfterRoot=([01]) descendantExitBeforeCleanup=(\d+)\r?\n/mu);
    if(!match) {
      // Native sandbox/compiler evidence only, not application output or a
      // production diagnostic parser. Retain a bounded cause for investigation.
      const error=new Error(/Add-Type|CS[0-9]{4}|CompilerError/u.test(stderr)?'owned_tree_supervisor_compile_failed':'owned_tree_completion_unproven');
      error.supervisorExit=code;error.nativeSandboxStderr=stderr.slice(-8192);
      throw error; // Keep fixture; never retry rm or infer successful termination.
    }
    const proof={platform:'windows-job',root:Number(match[1]),assignedBeforeResume:true,activeBefore:Number(match[2]),activeAfter:0,cancelled:match[3]==='1',rootExit:Number(match[4]),injected:match[5]==='1',witnessedLiveOwned:match[6]==='1',descendantAliveAfterRoot:match[7]==='1',descendantExitBeforeCleanup:Number(match[8])};
    Object.assign(record,proof);
    stderr=stderr.replace(match[0],'');
    if(code!==(proof.injected?66:proof.rootExit) || signal) throw new Error('owned_tree_supervisor_exit_invalid');
    return {code:proof.rootExit,bodyCode:proof.rootExit,signal:null,stdout,stderr,proof,cleanupFailure:proof.injected};
  }
  // A new session/group is created by spawn before any test code can fork.
  const child=spawn(command,args,{env,cwd,detached:true,stdio:driver?['ignore','pipe','pipe','ipc']:['ignore','pipe','pipe']});
  const closed=once(child,'close');
  child.stdout.on('data',data=>{stdout+=data;}); child.stderr.on('data',data=>{stderr+=data;});
  let ready,cancelled=false;
  const cancellation={kill:signal=>{assert.ok(child.pid>0 && child.exitCode===null && child.signalCode===null);process.kill(-child.pid,signal);cancelled=true;return true;}};
  onSpawn?.(cancellation);
  if(driver) {
    ready=await new Promise((resolve,reject)=>{
      child.on('message',message=>{if(message?.ownedReady && message.pid===child.pid)resolve(message);});
      child.once('close',()=>reject(new Error('owned_leader_exited_before_teardown')));
    });
    assert.ok(child.exitCode===null && child.signalCode===null);
    process.kill(-child.pid,'SIGKILL'); // Still-live owned leader prevents PGID reuse at this action.
  }
  const [code,signal]=await closed;
  const bound=Date.now()+10000;
  while(true) {
    try { process.kill(-child.pid,0); } catch(error) { if(error.code==='ESRCH')break;throw error; }
    if(Date.now()>=bound)throw new Error('owned_group_completion_unproven');
    await new Promise(resolve=>setImmediate(resolve)); // Condition audit, not a sleep/retry of cleanup.
  }
  const proof={platform:'posix-session',root:child.pid,assignedBeforeResume:true,activeAfter:0,rootExit:code,rootSignal:signal,cancelled,injected:injectCleanupFailure};
  Object.assign(record,proof);
  return {code,bodyCode:ready?.bodyCode??code,signal,stdout,stderr,proof,cleanupFailure:injectCleanupFailure};
}

test('native ownership handshake proves live members, early parent exit and surviving owned descendant termination (no HTTP or files)',async t=>{
  const leaf=String.raw`
    process.on('disconnect',()=>{});
    setInterval(()=>{},60000);
    setTimeout(()=>process.exit(99),12000); // Sandbox safety bound, never a smoke timeout change.
    const pgid=process.platform==='win32'?null:Number(require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)]).toString().trim());
    process.send({pid:process.pid,pgid});
  `;
  const subroot=`
    const {spawn}=require('node:child_process');
    let released=false;
    const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',value=>process.send(value));
    child.once('exit',code=>{if(!released)process.exit(code||99);});
    process.once('message',()=>{released=true;child.removeAllListeners('message');child.disconnect();child.unref();process.disconnect();});
  `;
  const variants=process.platform==='win32'?[false,true]:[false];
  for(const detached of variants){
    const ledger=[];
    const body=`
      const {spawn,execFileSync}=await import('node:child_process');const {once}=await import('node:events');
      let child,diagnostic;
      try {
        child=spawn(process.execPath,['-e',${JSON.stringify(process.platform==='win32'?leaf:subroot)}],{
          detached:${detached},stdio:['ignore','ignore','ignore','ipc'],
        });
        const [ready]=await Promise.race([
          once(child,'message'),
          once(child,'close').then(()=>{throw new Error('descendant_exited_before_live_handshake');}),
        ]);
        if(process.platform==='win32'){
          const {createConnection}=await import('node:net');
          const answer=await new Promise((resolve,reject)=>{
            const pipe=createConnection(${JSON.stringify('\\\\.\\pipe\\')}+process.env.OWNED_TEST_CONTROL_PIPE);let text='';
            pipe.on('error',reject);pipe.on('connect',()=>pipe.write('witness '+ready.pid+'\\n'));
            pipe.on('data',data=>{text+=data;if(text.includes('\\n')){pipe.end();resolve(text.trim());}});
          });
          if(answer!=='owned-live')throw new Error('native_live_membership_unproven');
          diagnostic={descendant:ready.pid,liveOwnedBeforeRelease:true};
          child.removeAllListeners('message');child.disconnect();child.unref();
        }else{
          if(ready.pgid!==process.pid || child.exitCode!==null)throw new Error('live_group_membership_unproven');
          process.kill(ready.pid,0);
          const closed=once(child,'close');child.send('release');const [exit]=await closed;
          if(exit!==0)throw new Error('early_subroot_exit_failed');
          const state=execFileSync('ps',['-o','stat=,pgid=','-p',String(ready.pid)]).toString().trim().split(/\\s+/);
          if(!state[0] || state[0].includes('Z') || Number(state[1])!==process.pid)throw new Error('surviving_owned_descendant_unproven');
          diagnostic={descendant:ready.pid,liveOwnedBeforeRelease:true,earlyRootExited:true,descendantAliveAfterRoot:true};
        }
      }catch(error){diagnostic={error:error.message};process.exitCode=1;
        if(child?.connected)child.disconnect();child?.unref();}
      process.stdout.write(JSON.stringify(diagnostic));
    `+posixDriverBarrier;
    const result=await ownedTestProcess(process.execPath,['--input-type=module','-e',body],{driver:true,ledger});
    const diagnostic=JSON.parse(result.stdout);
    assert.equal(result.bodyCode,0,JSON.stringify({diagnostic,proof:result.proof}));
    assert.equal(diagnostic.liveOwnedBeforeRelease,true);
    assert.equal(result.proof.assignedBeforeResume,true);assert.equal(result.proof.activeAfter,0);
    if(process.platform==='win32'){
      assert.equal(result.proof.witnessedLiveOwned,true,'native handles confirm root AND leaf live in this Job before release');
      assert.equal(result.proof.rootExit,0);
      if(detached){
        assert.equal(result.proof.descendantAliveAfterRoot,true,'retain the actual orphan-risk branch after root exit');
        assert.ok(result.proof.activeBefore>=1,'owned descendant still exists before teardown');
        assert.equal(result.proof.descendantExitBeforeCleanup,259,'STILL_ACTIVE before Job termination');
      }
      t.diagnostic(`native Windows detached=${detached}: live membership witnessed; root exit=${result.proof.rootExit}; descendant alive after root=${result.proof.descendantAliveAfterRoot}; pre-cleanup exit=${result.proof.descendantExitBeforeCleanup}; active after cleanup=0`);
    }else{
      assert.equal(diagnostic.earlyRootExited,true);assert.equal(diagnostic.descendantAliveAfterRoot,true);
    }
    assert.equal(ledger.length,1);assert.equal(ledger[0].activeAfter,0);
  }
});

test('real smoke checks route HTML and the delivered local module graph, health, readiness and Origin', async t => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') return t.skip('Git Bash is unavailable');
  assert.equal(available.status, 0, available.stderr);
  const ownership=[];

  const publicRoot = path.resolve('public');
  const files = new Map(await Promise.all([
    ['/autocard.html', 'public/autocard.html'],
    ['/autocard/', 'public/autocard/index.html'],
    ['/index.html', 'public/index.html'],
    ['/js/router-bootstrap.js', 'public/js/router-bootstrap.js'],
    ['/js/router.js', 'public/js/router.js'],
    ['/autocard/entry.js', 'public/autocard/entry.js'],
    ['/js/owner-news/asset-path.mjs', 'public/js/owner-news/asset-path.mjs'],
  ].map(async ([url, file]) => [url, await readFile(file, 'utf8')])));
  const overrides = new Map();
  const origins = [];
  const requests = [];
  const contentTypes = new Map();
  let rejectOrigin = false;
  let transientLivenessFailures = 0;
  let interruptRequest = null;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname);
    const override = overrides.get(pathname);
    if (override) {
      if (override.stall) {
        res.writeHead(200, {'Content-Type':'text/html'});
        res.write(override.body ?? '');
        interruptRequest?.();
        return; // Real unfinished HTTP response; curl's unchanged max-time applies.
      }
      res.writeHead(override.status ?? 200, override.headers ?? {});
      res.end(override.body ?? files.get(pathname) ?? 'Unavailable');
      return;
    }
    if (pathname === '/api/health') {
      if (!req.headers.origin && transientLivenessFailures > 0) {
        transientLivenessFailures--;
        res.writeHead(503);res.end('temporarily unavailable');return;
      }
      if (req.headers.origin) origins.push(req.headers.origin);
      if (req.headers.origin && rejectOrigin) {
        res.writeHead(403); res.end('{"error":"Request not allowed."}');
      } else res.end('{"status":"ok"}');
      return;
    }
    if (pathname === '/api/ready') {
      res.end('{"status":"ready"}');
      return;
    }
    if (pathname === '/editorial') {
      res.writeHead(308, { Location: '/editorial/admin' });
      res.end();
      return;
    }

    let filename = path.resolve(publicRoot, `.${decodeURIComponent(pathname)}`);
    if (filename !== publicRoot && !filename.startsWith(`${publicRoot}${path.sep}`)) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    try {
      if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
      const body = await readFile(filename);
      const extension = path.extname(filename).toLowerCase();
      const contentType = extension === '.html' ? 'text/html; charset=utf-8'
        : extension === '.css' ? 'text/css; charset=utf-8'
          : ['.js', '.mjs'].includes(extension) ? 'application/javascript; charset=utf-8'
            : 'application/octet-stream';
      contentTypes.set(pathname, contentType);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = async ({baseUrl=origin,attempts='1',onSpawn}={}) => {
    const result=await ownedTestProcess(bash,['scripts/smoke.sh'],{
      env: { ...process.env, BASE_URL: `${baseUrl}/`, SMOKE_ATTEMPTS: attempts },
      onSpawn,ledger:ownership,
    });
    return {code:result.code,signal:result.signal,output:result.stdout+result.stderr,ownership:result.proof};
  };

  await t.test('transient liveness failure retries then accepts the same complete checkout graph on the configured second attempt', async () => {
    transientLivenessFailures=1;
    const accepted = await run({attempts:'2'});
    assert.equal(accepted.code, 0, `${accepted.output}\nrequests: ${requests.join(' ')}`);
    assert.match(accepted.output, /"status":"ok"/);
    assert.match(accepted.output, /"attempt":2/);
    assert.equal(transientLivenessFailures,0);
    const router = await readFile('public/js/router.js', 'utf8');
    const routes = [...router.matchAll(/^\s*'([^']+\.html)': '([^']+)'/gm)];
    assert.equal(routes.length, 14, 'all registered direct-link pages should be checked');
    for (const [, route] of routes) assert.ok(requests.includes(route), `Smoke must fetch ${route}`);
    assert.ok(requests.includes('/js/owner-news/asset-path.mjs'), 'Smoke must fetch the .mjs dependency');
    for (const asset of ['/js/index.js', '/js/auth-shell.js', '/js/sidebar-state.js', '/js/sidebar.js']) {
      assert.ok(requests.includes(asset), `Smoke must fetch local shell dependency ${asset}`);
    }
    assert.match(contentTypes.get('/js/owner-news/asset-path.mjs'), /^(application|text)\/(javascript|ecmascript)/i);
    assert.ok(requests.includes('/__route_recovery_missing__.html'), 'Smoke must reject a missing .html route');
    assert.deepEqual(origins, [origin,origin]);
  });

  await t.test('rejects browser Origin even when plain health and readiness pass', async () => {
    rejectOrigin = true;
    try {
      const rejected = await run();
      assert.equal(rejected.code, 1, rejected.output);
      assert.match(rejected.output, /"status":"failed"/);
      assert.deepEqual(extractSmokeFailure(rejected.output,{smokeCommandContext:FIXTURE_SMOKE_CONTEXT,substep:'fixture_full_smoke',status:rejected.code}),
        {check:'same_origin',reason:'http_status',httpStatus:null});
      assert.equal(origins.at(-1), origin);
    } finally { rejectOrigin = false; }
  });

  const failures = [
    ['liveness unavailable', '/api/health', { status: 503 }],
    ['readiness unavailable', '/api/ready', { status: 503 }],
    ['root unavailable', '/', { status: 404 }],
    ['generic canonical HTML', '/autocard.html', { body: files.get('/index.html') }],
    ['missing shell', '/autocard.html', { body: files.get('/autocard.html').replace('class="sidebar"', 'class="missing-sidebar"') }],
    ['missing module bootstrap tag', '/autocard.html', { body: files.get('/autocard.html').replace('type="module" src="./js/router-bootstrap.js"', 'src="./js/router-bootstrap.js"') }],
    ['incomplete canonical HTML transfer even with all expected markers', '/autocard.html', {
      body:files.get('/autocard.html'),
      headers:{'Content-Length':Buffer.byteLength(files.get('/autocard.html'))+20,Connection:'close'},
    }],
    ['broken legacy alias', '/autocard/', { body: files.get('/autocard/').replaceAll('../autocard.html', '../login.html') }],
    ['HTML fallback for a nonexistent .html route', '/__route_recovery_missing__.html', {
      body: files.get('/index.html'), headers: { 'Content-Type': 'text/html' },
    }],
    ['empty 200 for a nonexistent .html route', '/__route_recovery_missing__.html', { status: 200, body: '' }],
    ['unexpected 503 for a nonexistent .html route', '/__route_recovery_missing__.html', { status: 503, body: '' }],
    ...['/js/router-bootstrap.js', '/js/router.js', '/autocard/entry.js'].flatMap(url => [
      [`404 for ${url} even with the expected body`, url, { status: 404, body: files.get(url) }],
      [`HTML fallback for ${url}`, url, { body: files.get('/index.html'), headers: { 'Content-Type': 'text/html' } }],
    ]),
    ['truncated bootstrap without startRouter call', '/js/router-bootstrap.js', { body: files.get('/js/router-bootstrap.js').split('\n')[0] }],
    ['bootstrap with wrong import', '/js/router-bootstrap.js', { body: files.get('/js/router-bootstrap.js').replace('./router.js', './missing-router.js') }],
    ['incomplete bootstrap HTTP transfer', '/js/router-bootstrap.js', {
      body: files.get('/js/router-bootstrap.js'),
      headers: { 'Content-Length': Buffer.byteLength(files.get('/js/router-bootstrap.js')) + 20, Connection: 'close' },
    }],
    ['wrong AutoCard route', '/js/router.js', { body: files.get('/js/router.js').replace("'/autocard.html': '../autocard/entry.js'", "'/autocard.html': './dashboard.js'") }],
    ['truncated router before startRouter', '/js/router.js', { body: files.get('/js/router.js').split('export async function startRouter')[0] }],
    ['entry without mount export', '/autocard/entry.js', { body: files.get('/autocard/entry.js').replace('export function mount', 'function mount') }],
    ['truncated entry body', '/autocard/entry.js', { body: files.get('/autocard/entry.js').trimEnd().slice(0, -1) }],
    ['.mjs served as application/octet-stream', '/js/owner-news/asset-path.mjs', {
      body: files.get('/js/owner-news/asset-path.mjs'), headers: { 'Content-Type': 'application/octet-stream' },
    }],
    ['HTML fallback for .mjs', '/js/owner-news/asset-path.mjs', {
      body: files.get('/index.html'), headers: { 'Content-Type': 'text/html' },
    }],
    ['missing transitive .mjs dependency', '/js/owner-news/asset-path.mjs', {
      status: 404, body: files.get('/js/owner-news/asset-path.mjs'),
    }],
    ['incomplete .mjs HTTP transfer', '/js/owner-news/asset-path.mjs', {
      body: files.get('/js/owner-news/asset-path.mjs'),
      headers: { 'Content-Length': Buffer.byteLength(files.get('/js/owner-news/asset-path.mjs')) + 20, Connection: 'close' },
    }],
    ['absolute editorial redirect', '/editorial', { status: 308, headers: { Location: `${origin}/editorial/admin` } }],
  ];
  for (const [name, url, response] of failures) {
    await t.test(`rejects ${name}`, async () => {
      overrides.set(url, response);
      try {
        const rejected = await run();
        assert.equal(rejected.code, 1, rejected.output);
        assert.match(rejected.output, /"status":"failed"/);
        const check=url==='/api/health'?'api_liveness':url==='/api/ready'?'api_readiness':url==='/'?'root'
          :url==='/autocard.html'?'canonical_html':url==='/autocard/'?'legacy_alias':url==='/__route_recovery_missing__.html'?'missing_html'
          :url==='/editorial'?'editorial_redirect':url==='/js/router-bootstrap.js'?'router_bootstrap':url==='/js/router.js'?'router_module'
          :url==='/autocard/entry.js'?'autocard_entry':'asset_path_module';
        const javascript=['router_bootstrap','router_module','autocard_entry','asset_path_module'].includes(check);
        const transport=name.startsWith('incomplete');
        const reason=transport?'transport':response.status>=400 || check==='missing_html'?'http_status'
          :check==='editorial_redirect'?'redirect':javascript?'module':'content';
        const httpStatus=javascript?response.status??200:check==='missing_html'?response.status??200:check==='editorial_redirect'?308:null;
        assert.deepEqual(extractSmokeFailure(rejected.output,{smokeCommandContext:FIXTURE_SMOKE_CONTEXT,substep:'fixture_full_smoke',status:rejected.code}),
          {check,reason,httpStatus},'metadata must come from the existing actual call result; no resource/body/URL is published');
      } finally { overrides.clear(); }
    });
  }

  await t.test('unchanged curl HTTP timeout rejects a partial legacy body instead of accepting its valid prefix',async()=>{
    overrides.set('/autocard/',{stall:true,body:files.get('/autocard/')});
    const start=Date.now();
    try{
      const result=await run();
      assert.equal(result.code,1);assert.match(result.output,/"status":"failed"/);
      assert.deepEqual(extractSmokeFailure(result.output,{smokeCommandContext:FIXTURE_SMOKE_CONTEXT,substep:'fixture_full_smoke',status:result.code}),
        {check:'legacy_alias',reason:'transport',httpStatus:null});
      assert.ok(Date.now()-start>=4500,'the real response waits for the existing 5s curl bound');
    }finally{overrides.clear();}
  });

  await t.test('real smoke process interrupted during unfinished HTTP cannot return success (native process signal semantics may differ on Windows)',async()=>{
    overrides.set('/autocard/',{stall:true,body:files.get('/autocard/')});
    let killed=false;
    try{
      const result=await run({onSpawn:child=>{interruptRequest=()=>{interruptRequest=null;killed=child.kill('SIGTERM');};}});
      assert.equal(killed,true,'interrupt only after the server sees the actual held HTTP request');
      assert.notEqual(result.code,0,'signal/termination is never a smoke PASS');
      assert.equal(result.ownership.cancelled,true,'native tree cancellation must be acknowledged, not only queued');
    }finally{interruptRequest=null;overrides.clear();}
  });

  // Run the synchronous production command wrapper in a real Node child, so
  // this parent can continue serving real HTTP while bash/curl executes. Only
  // Docker metadata and the destructive callback are doubles, never smoke.
  const release=await mkdtemp(path.join(os.tmpdir(),'fixture-full-smoke-'));
  let removalCalls=0;
  t.after(async()=>{
    assert.ok(ownership.every(item=>item.assignedBeforeResume && item.activeAfter===0),'uncertain ownership/termination must retain the fixture');
    assert.equal(removalCalls,0);removalCalls++;
    await rm(release,{recursive:true,force:true}); // Exactly once. No rm retries/delays.
    assert.equal(removalCalls,1);
  });
  await mkdir(path.join(release,'scripts'));
  await cp('scripts/smoke.sh',path.join(release,'scripts','smoke.sh'));
  assert.deepEqual(await readFile(path.join(release,'scripts','smoke.sh')),await readFile('scripts/smoke.sh'));
  const project=createFixtureProjectNames({commit:'f4a4c71744cdce3169e80acac83003da841e298c',runId:'37997573123',runAttempt:'1'}).source;
  const inventory=createInventory({project,root:release});
  const identity='d'.repeat(64);
  const runtime={project,inventory,directory:inventory.document.paths.runtime,payloadRelease:release,
    port:server.address().port,baseUrl:origin,fixtureNginxIdentity:identity};
  const nginx={Id:identity,Config:{Labels:{'com.docker.compose.project':project,'com.docker.compose.service':'nginx','com.docker.compose.oneoff':'False'}},
    State:{Status:'running',Running:true,Paused:false,Restarting:false},
    NetworkSettings:{Ports:{'80/tcp':[{HostIp:'127.0.0.1',HostPort:String(runtime.port)}]}}};
  const commandModule=pathToFileURL(path.resolve('scripts/integration/payload-preauthority-command.mjs')).href;
  const runtimeModule=pathToFileURL(path.resolve('scripts/integration/payload-preauthority-snapshot-runtime.mjs')).href;
  const flowModule=pathToFileURL(path.resolve('scripts/integration/payload-preauthority-recovery-flow.mjs')).href;
  const driver=`
    import path from 'node:path';
    import {runFixtureSmokePreflight,runFixtureCommand} from ${JSON.stringify(commandModule)};
    import {awaitFixtureProxyAvailability,recoveryFixtureEnvironment} from ${JSON.stringify(runtimeModule)};
    import {createRecoveryFailureReportFields} from ${JSON.stringify(flowModule)};
    const input=JSON.parse(process.argv[1]);
    const attempts=input.attempts || '1';
    const environment={...recoveryFixtureEnvironment(input.runtime.project,input.runtime,process.env.PATH),SMOKE_ATTEMPTS:attempts};
    const evidence=[],effects=[],observed=[];let commands=0,transportCorrect=false;
    try {
      await runFixtureSmokePreflight(input.runtime,{
        environment,
        verifyProxy:async(runtime,id)=>{observed.push(id);await awaitFixtureProxyAvailability(runtime,id,()=>input.nginx);},
        execute:(command,args,options)=>{
          commands++;
          transportCorrect=command==='bash' && args.length===1 && args[0]===path.join(input.runtime.payloadRelease,'scripts','smoke.sh')
            && options.cwd===input.runtime.payloadRelease && options.env.BASE_URL===environment.RESTORE_BASE_URL
            && options.env.BASE_URL===input.runtime.baseUrl && options.env.SMOKE_ATTEMPTS===attempts
            && options.timeout===15*60_000 && options.preservePrivateErrorEvidence===true;
          // Test-only lower wrapper deadline, never a production timeout edit.
          return runFixtureCommand(input.bash,args,{...options,...(input.commandTimeout?{timeout:input.commandTimeout}:{}),privateCommandEvidence:evidence});
        },
        afterSmoke:()=>{effects.push(...(input.phase==='initial'?['seed']:['target_before','pg_restore','storage_clear']));},
      });
      process.stdout.write(JSON.stringify({ok:true,effects,observed,commands,transportCorrect}));
    } catch(error) {
      process.stdout.write(JSON.stringify({ok:false,effects,observed,commands,transportCorrect,
        failure:createRecoveryFailureReportFields({primaryError:error,primarySubstep:'fixture_full_smoke'}),privateStderrRetained:evidence.length>0}));
    }
  `+posixDriverBarrier;
  const gate=async(phase,change=()=>{})=>{
    const input={runtime:structuredClone(runtime),nginx:structuredClone(nginx),bash,phase};change(input);
    const result=await ownedTestProcess(process.execPath,['--input-type=module','-e',driver,JSON.stringify(input)],{
      driver:true,ledger:ownership,injectCleanupFailure:input.injectCleanupFailure===true,
    });
    assert.equal(result.bodyCode,0,result.stderr);assert.equal(result.stderr,'','no private tool output from the helper driver');
    const primary=JSON.parse(result.stdout);
    if(result.cleanupFailure){
      const error=new Error('injected_owned_cleanup_reporting_failure');
      error.primaryResult=primary;error.ownership=result.proof;
      throw error; // Preserve actual smoke failure; never substitute a cleanup result for it.
    }
    return {...primary,ownership:result.proof};
  };

  await t.test('actual producer → command wrapper → release smoke fully checks HTTP before initial seed and both positive restore callbacks',async()=>{
    for(const phase of ['initial','first','second']){
      const start=requests.length;
      const result=await gate(phase);
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(result.transportCorrect,true);assert.equal(result.commands,1);
      assert.deepEqual(result.observed,[identity,identity],'verify the saved identity before and after full smoke, never adopt a new one');
      assert.deepEqual(result.effects,phase==='initial'?['seed']:['target_before','pg_restore','storage_clear']);
      const actual=requests.slice(start);
      for(const url of ['/api/health','/api/ready','/autocard.html','/__route_recovery_missing__.html','/editorial','/js/router.js','/js/owner-news/asset-path.mjs'])assert.ok(actual.includes(url),url);
    }
  });

  await t.test('missing proxy ID, swapped identity or wrong bound port refuses before smoke/target snapshot/destructive callback',async()=>{
    const start=requests.length;
    for(const [code,change] of [
      ['fixture_nginx_identity_invalid',input=>{delete input.runtime.fixtureNginxIdentity;}],
      ['fixture_nginx_identity_invalid',input=>{input.nginx.Id='e'.repeat(64);} ],
      ['fixture_nginx_port_invalid',input=>{input.nginx.NetworkSettings.Ports['80/tcp'][0].HostPort='1';}],
    ]){
      const result=await gate('first',change);
      assert.equal(result.ok,false);assert.equal(result.failure.failureCode,code);
      assert.equal(result.commands,0);assert.deepEqual(result.effects,[]);
    }
    assert.equal(requests.length,start,'no HTTP traffic or full smoke before refusal');
  });

  await t.test('dead assigned endpoint refuses before any full smoke or destructive callback',async()=>{
    const unavailable=createServer();unavailable.listen(0,'127.0.0.1');await once(unavailable,'listening');
    const port=unavailable.address().port;await new Promise(resolve=>unavailable.close(resolve));
    const direct=await run({baseUrl:`http://127.0.0.1:${port}`});
    assert.equal(direct.code,1,'the real script itself also rejects refused connections');
    const result=await gate('second',input=>{
      input.runtime.port=port;input.runtime.baseUrl=`http://127.0.0.1:${port}`;
      input.nginx.NetworkSettings.Ports['80/tcp'][0].HostPort=String(port);
    });
    assert.equal(result.ok,false);assert.equal(result.failure.failureCode,'fixture_nginx_http_unavailable');
    assert.equal(result.commands,0);assert.deepEqual(result.effects,[]);
  });

  await t.test('attempt exhaustion in initial and both positive gates retains primary and prevents seed/snapshot/restore/clear despite API availability',async()=>{
    overrides.set('/',{status:503,body:'private synthetic response'});
    try{
      for(const phase of ['initial','first','second']){
        const start=requests.length;
        const result=await gate(phase,input=>{input.attempts='2';});
        assert.equal(result.ok,false);assert.equal(result.commands,1);assert.equal(result.transportCorrect,true);
        assert.equal(result.failure.failureCode,'fixture_full_smoke_failed');
        assert.equal(result.failure.commandDiagnostic.substep,'fixture_full_smoke');
        assert.equal(result.failure.commandDiagnostic.commandExitCode,1);
        assert.deepEqual(result.failure.commandDiagnostic.smokeFailure,{check:'root',reason:'http_status',httpStatus:null});
        assert.equal(result.privateStderrRetained,true);assert.deepEqual(result.effects,[]);
        assert.equal(requests.slice(start).filter(url=>url==='/').length,2,'exhaust exactly the two configured real attempts');
        assert.doesNotMatch(JSON.stringify(result.failure),/private synthetic|fixture-full-smoke|127\.0\.0\.1/u);
      }
    }finally{overrides.clear();}
  });

  await t.test('actual command wrapper timeout during smoke refuses before snapshot/destruction callback without changing production bounds',async()=>{
    overrides.set('/autocard/',{stall:true,body:files.get('/autocard/')});
    try{
      const result=await gate('first',input=>{input.commandTimeout=500;});
      assert.equal(result.ok,false);assert.equal(result.commands,1);assert.equal(result.transportCorrect,true);
      assert.equal(result.failure.failureCode,'fixture_full_smoke_failed');
      assert.equal(result.failure.commandDiagnostic.commandError,'command_timeout');
      assert.equal(result.failure.commandDiagnostic.smokeFailure,undefined,'an outer timeout cannot impersonate a complete smoke failure');
      assert.deepEqual(result.effects,[]);
      assert.equal(result.ownership.activeAfter,0,'all owned descendants must be terminated before the single release rm');
      assert.equal(removalCalls,0);
    }finally{overrides.clear();}
  });

  await t.test('cleanup reporting failure does not replace actual wrapper timeout; owned tree is still terminated and rm is not retried',async()=>{
    overrides.set('/autocard/',{stall:true,body:files.get('/autocard/')});
    try{
      await assert.rejects(gate('first',input=>{input.commandTimeout=500;input.injectCleanupFailure=true;}),error=>{
        assert.equal(error.message,'injected_owned_cleanup_reporting_failure');
        assert.equal(error.primaryResult.failure.failureCode,'fixture_full_smoke_failed');
        assert.equal(error.primaryResult.failure.commandDiagnostic.commandError,'command_timeout');
        assert.deepEqual(error.primaryResult.effects,[]);
        assert.equal(error.ownership.activeAfter,0);
        assert.equal(removalCalls,0);
        return true;
      });
    }finally{overrides.clear();}
  });
});
