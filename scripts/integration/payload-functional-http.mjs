import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { fail } from './payload-functional-fixture.mjs';

// Node18-compatible, bounded TLS transport. No redirects or insecure trust flags.
export function httpsFixtureClient(origin, ca, requestImpl = https.request) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/' || base.search || base.hash || base.username) fail('functional_https_origin_invalid');
  return async (pathname,{ method='GET',body,headers={},timeout=15000 } = {}) => {
    if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\x00-\x1f]/.test(pathname)) fail('functional_http_path_invalid');
    const url = new URL(pathname,base);
    if (url.origin !== base.origin || !['GET','POST','DELETE'].includes(method)) fail('functional_http_request_invalid');
    return new Promise((resolve,reject) => {
      let timer;
      const finish=(value,error)=>{clearTimeout(timer);if(error) reject(error);else resolve(value);};
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const request = requestImpl(url,{ method,ca,rejectUnauthorized:true,headers:{
        ...(data ? { 'Content-Type':'application/json','Content-Length':String(data.length) } : {}),...headers } }, response => {
        let bytes = Buffer.alloc(0);
        response.on('data',chunk => {
          if (bytes.length + chunk.length > 1024 * 1024) { response.destroy(); request.destroy(); finish(null,new Error('functional_http_output_limit')); }
          else bytes = Buffer.concat([bytes,chunk]);
        });
        response.on('error',() => finish(null,new Error('functional_http_response_failed')));
        response.on('end',() => {
          let json = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* HTML readiness remains explicit. */ }
          finish({ status:response.statusCode,headers:response.headers,json });
        });
      });
      timer=setTimeout(()=>request.destroy(new Error('functional_http_timeout')),timeout);
      request.on('error',() => finish(null,new Error('functional_https_transport_failed')));
      request.end(data);
    });
  };
}

export function inspectEditorialCookie(response,origin) {
  const values = response.headers['set-cookie'];
  if (!Array.isArray(values) || values.length !== 1) fail('functional_cookie_missing');
  const text = values[0], pair = text.split(';',1)[0];
  if (!pair.startsWith('__Host-ownerinc-editorial=') || /(?:^|;)\s*Domain=/i.test(text) ||
    !/(?:^|;)\s*Secure(?:;|$)/i.test(text) || !/(?:^|;)\s*HttpOnly(?:;|$)/i.test(text) ||
    !/(?:^|;)\s*Path=\/(?:;|$)/i.test(text) || !/(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(text)) fail('functional_cookie_policy_mismatch');
  const expires = Date.parse(response.json?.expiresAt);
  if (!Number.isFinite(expires) || expires - Date.now() < 7100000 || expires - Date.now() > 7210000) fail('functional_session_lifetime_mismatch');
  const cookie = { name:'__Host-ownerinc-editorial',value:pair.slice(pair.indexOf('=')+1),url:origin,httpOnly:true,secure:true,sameSite:'Lax' };
  return { pair,cookie };
}

export async function createSyntheticAccounts(client,identity,sql) {
  const accounts = {};
  for (const [name,role,permissions] of [ ['academy','admin',{manageAcademy:true}],['benefits','admin',{manageBenefits:true}],['viewer','viewer',{}] ]) {
    const email = `${name}-${identity.runId}@example.test`, password = randomBytes(24).toString('hex');
    const signup = await client('/identitytoolkit.googleapis.com/v1/accounts:signUp?key=functional-emulator-only',{
      method:'POST',body:{email,password,returnSecureToken:true} });
    if (signup.status !== 200 || typeof signup.json?.localId !== 'string') fail('functional_emulator_signup_failed');
    const uid = signup.json.localId;
    const updated = await client('/identitytoolkit.googleapis.com/v1/accounts:update?key=functional-emulator-only',{
      method:'POST',headers:{Authorization:'Bearer owner'},body:{localId:uid,emailVerified:true} });
    if (updated.status !== 200) fail('functional_emulator_verification_failed');
    const signin = await client('/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=functional-emulator-only',{
      method:'POST',body:{email,password,returnSecureToken:true} });
    const token = signin.json?.idToken;
    if (signin.status !== 200 || signin.json?.localId !== uid || typeof token !== 'string') fail('functional_emulator_signin_failed');
    let claims; try { claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')); } catch { fail('functional_emulator_token_invalid'); }
    if (claims.aud !== identity.firebaseProject || claims.iss !== `https://securetoken.google.com/${identity.firebaseProject}` || claims.sub !== uid || claims.email_verified !== true) fail('functional_emulator_token_identity_mismatch');
    const lookup = await client('/identitytoolkit.googleapis.com/v1/accounts:lookup?key=functional-emulator-only',{method:'POST',body:{idToken:token}});
    if (lookup.status !== 200 || lookup.json?.users?.length !== 1 || lookup.json.users[0].localId !== uid || lookup.json.users[0].emailVerified !== true) fail('functional_emulator_lookup_failed');
    const created = await sql('portal',`INSERT INTO users(uid,email,name,role,permissions)
      VALUES (:'uid',:'email',:'name',:'role',:'permissions'::jsonb) RETURNING uid;`,{uid,email,name:'Functional synthetic '+name,role,permissions:JSON.stringify(permissions)});
    if (created !== uid) fail('functional_profile_seed_failed');
    accounts[name] = {uid,email,password,token};
  }
  return accounts;
}
