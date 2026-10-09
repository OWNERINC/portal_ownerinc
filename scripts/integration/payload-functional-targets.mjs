import { fail, nginxImage, postgresImage, runProcess } from './payload-functional-fixture.mjs';
import { assertContainerNetwork,assertImageEnvironment,assertNoPublishedPorts,probeImageFiles } from './payload-functional-isolation.mjs';

export function assertFreshResources(identity, observation) {
  if (!observation || observation.containers !== '' || observation.volumes !== '' || observation.networks !== '') {
    fail('functional_existing_resources_refused');
  }
  if (Object.values(identity.containers).some(name => !name.startsWith(identity.project + '-')) ||
    Object.values(identity.volumes).some(name => !name.startsWith(identity.project + '-'))) fail('functional_resource_identity_invalid');
}

export function assertVolumeBinding(identity, role, observed) {
  if (observed?.Name !== identity.volumes[role] || observed.Driver !== 'local' ||
    Object.keys(observed.Options || {}).length !== 0 || observed.Labels?.['com.docker.compose.project'] !== identity.project ||
    observed.Labels?.['ownerinc.functional.run'] !== identity.runId || observed.Labels?.['ownerinc.functional.role'] !== role) {
    fail('functional_volume_binding_mismatch');
  }
}

export function assertContainerBinding(identity, role, observed, imageId) {
  const labels = observed?.Config?.Labels;
  if (observed?.Name !== '/' + identity.containers[role] || observed.Image !== imageId ||
    labels?.['com.docker.compose.project'] !== identity.project || labels?.['ownerinc.functional.run'] !== identity.runId ||
    labels?.['ownerinc.functional.role'] !== role || observed.HostConfig?.Privileged || observed.HostConfig?.NetworkMode === 'host') {
    fail('functional_container_binding_mismatch');
  }
  const expectedVolumes = { 'portal-db': ['portal-db','/var/lib/postgresql/data'], 'cms-db': ['cms-db','/var/lib/postgresql/data'],
    api: ['portal-uploads','/app/uploads'], cms: ['cms-uploads','/var/lib/ownerinc-cms/media'] };
  const expected = expectedVolumes[role];
  if (expected) {
    const mounts = observed.Mounts || [];
    if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== identity.volumes[expected[0]] ||
      mounts[0].Destination !== expected[1] || mounts[0].RW !== true) fail('functional_container_mount_mismatch');
  }
  assertNoPublishedPorts(observed);
  assertContainerNetwork(identity,observed);
}

export function assertPhysicalTargets(identity, portal, cms) {
  const check = (value, database, role) => value?.database === database && value?.role === role &&
    /^[0-9]{10,20}$/.test(value?.systemIdentifier || '') && typeof value?.serverAddress === 'string' &&
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.serverAddress) && value?.serverPort === 5432 && value?.empty === true;
  if (!check(portal,identity.portalDatabase,'portal_admin') || !check(cms,identity.cmsDatabase,'cms_admin') ||
    portal.systemIdentifier === cms.systemIdentifier || portal.serverAddress === cms.serverAddress) fail('functional_physical_targets_not_independent');
}

export async function dockerPreflight(lease) {
  const docker = args => runProcess('docker',['--context','default',...args]);
  const context = JSON.parse(await docker(['context','inspect','default']))[0];
  if (!['unix:///var/run/docker.sock','unix:///run/docker.sock'].includes(context?.Endpoints?.docker?.Host)) fail('functional_local_docker_required');
  if (await docker(['info','--format','{{.OSType}}']) !== 'linux') fail('functional_linux_docker_required');
  const observation = { containers: await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${lease.identity.project}`]),
    volumes: await docker(['volume','ls','-q','--filter',`label=com.docker.compose.project=${lease.identity.project}`]),
    networks: await docker(['network','ls','-q','--filter',`name=^${lease.identity.project}-network$`]) };
  // Also reject exact-name collisions, even without Compose labels.
  for (const name of Object.values(lease.identity.containers)) if (await docker(['ps','-aq','--filter',`name=^/${name}$`])) fail('functional_existing_resources_refused');
  const allVolumes = (await docker(['volume','ls','-q'])).split('\n');
  if (Object.values(lease.identity.volumes).some(name => allVolumes.includes(name))) fail('functional_existing_resources_refused');
  assertFreshResources(lease.identity,observation);
  const images = {},imageEnvironments={};
  for (const [role,reference] of Object.entries({ api:lease.config.apiImage,cms:lease.config.cmsImage,emulator:lease.config.emulatorImage,postgres:postgresImage,nginx:nginxImage })) {
    const observed = JSON.parse(await docker(['image','inspect',reference]))[0];
    if (!/^sha256:[0-9a-f]{64}$/.test(observed?.Id || '')) fail('functional_cached_image_required');
    if (['api','cms'].includes(role) && observed.Config?.Labels?.['org.opencontainers.image.revision'] !== lease.config.commit) fail('functional_image_revision_unverified');
    imageEnvironments[role]=assertImageEnvironment(role,observed.Config,{reference,id:observed.Id,os:observed.Os,architecture:observed.Architecture});
    images[role] = observed.Id;
  }
  // No application entrypoint, daemon, env-file loader or network runs in these
  // read-only probes. They occur before creating fixture DBs/application services.
  for(const role of ['api','cms','emulator']) await probeImageFiles(docker,images[role],role);
  return { docker, images,imageEnvironments };
}

export function composeClient(lease) {
  return (args,options) => runProcess('docker',['--context','default','compose','--project-directory',lease.directory,
    '--env-file','/dev/null','--project-name',lease.identity.project,'--file',`${lease.directory}/compose.json`,...args],options);
}

export function fixtureSQL(compose, identity) {
  return async (store,sql,variables = {}) => {
    if (!['portal','cms'].includes(store)) fail('functional_store_invalid');
    const args = ['exec','-T',store + '-db','sh','-ec','export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h "$HOSTNAME" "$@"','sh',
      '-X','-qAt','-v','ON_ERROR_STOP=1','-U',store + '_admin',
      '-d',store === 'portal' ? identity.portalDatabase : identity.cmsDatabase];
    for (const [key,value] of Object.entries(variables)) {
      if (!['uid','email','name','hash','role','permissions'].includes(key) || typeof value !== 'string' || value.includes('\0')) fail('functional_sql_binding_invalid');
      args.push('-v',`${key}=${value}`);
    }
    args.push('-f','-');
    return compose(args,{ input: sql + '\n' });
  };
}

export async function inspectPhysicalTarget(sql,store) {
  // fixtureSQL uses the bound container hostname over TCP, not a Unix socket.
  return JSON.parse(await sql(store, `SELECT json_build_object('database',current_database(),'role',current_user,
    'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
    'serverAddress',host(inet_server_addr()),
    'serverPort',current_setting('port')::int,'empty',NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')))::text;`));
}
