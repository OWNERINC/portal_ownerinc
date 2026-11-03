#!/usr/bin/python3
"""ADMIN-only exact-B0 pre-floor recovery, loaded from authenticated bytes.

There is deliberately no CLI and no request-controlled command/target adapter.
The TEST executor is independent. File hashes include LF; value hashes do not.
"""
import copy
import hashlib
import json
import os
import posixpath
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit, unquote
from contextlib import contextmanager

PROFILE = '/etc/ownerinc/payload-preparation/production-recovery-profile.json'
CONTRACT = '/etc/ownerinc/payload-preparation/production-b0-recovery-contract.json'
DECISION = '/etc/ownerinc/payload-preparation/production-b0-recovery.json'
QUALIFICATION = '/etc/ownerinc/payload-preparation/b0-qualification-evidence.json'
PROCEDURE = '/etc/ownerinc/payload-preparation/b0-procedure.md'
SSH_CONFIG = '/etc/ownerinc/payload-preparation/recovery-witness.conf'
KNOWN_HOSTS = '/etc/ownerinc/payload-preparation/recovery-witness.known_hosts'
ENV_FILES = {name: '/etc/ownerinc/payload-preparation/recovery-' + name + '.env' for name in ('api', 'cron')}
READ_TOKEN = '/etc/ownerinc/payload-preparation/recovery-read-token'
HEX = re.compile(r'^[0-9a-f]{64}$')
ROUTES = ('/', '/api/ready', '/editorial/ready')
CAP = 4 * 1024 ** 2
PG_IMAGE = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
CMS_ROLES = ('cms_admin', 'cms_control', 'cms_controller', 'cms_migrator', 'cms_runtime', 'cms_observer')
BLOCKS = ('rich_text', 'heading', 'paragraph', 'list_items', 'list', 'image', 'callout', 'quote', 'profile', 'divider', 'link', 'pdf', 'video')
CMS_INITIAL = {'portal_editors', 'news_articles', '_news_articles_v', 'news_home', '_news_home_v', 'news_media',
    'payload_kv', 'payload_locked_documents', 'payload_locked_documents_rels', 'payload_migrations',
    'payload_preferences', 'payload_preferences_rels'} | {prefix + block for prefix in
    ('news_articles_blocks_', '_news_articles_v_blocks_') for block in BLOCKS}
CMS_PREFIXES = [set(), CMS_INITIAL, CMS_INITIAL,
    CMS_INITIAL | {'news_audit', 'news_schedules', 'payload_jobs', 'payload_jobs_log'}]
CMS_PREFIXES += [CMS_PREFIXES[-1] | {'legacy_news_revisions', 'legacy_news_revisions_rels'}] * 2
CMS_PREFIXES += [CMS_PREFIXES[-1] | {'news_migration_items', 'news_migration_runs'}]


class RecoveryError(Exception):
    pass


def require(value, reason='production_recovery_denied'):
    if not value:
        raise RecoveryError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def value_hash(value):
    return sha(canonical(value))


def keys(value, names):
    require(isinstance(value, dict) and set(value) == set(names.split()), 'recovery_contract_invalid')


def hash_value(value):
    require(isinstance(value, str) and HEX.fullmatch(value), 'recovery_contract_invalid')


def normalize_dump(raw):
    """Only pg_dump's random restrict/unrestrict key; no SQL rewriting."""
    pairs = re.findall(rb'^\\(unrestrict|restrict) ([A-Za-z0-9]+)\r?$', raw, re.M)
    require(not pairs or len(pairs) == 2 and pairs[0][0] == b'restrict' and
            pairs[1] == (b'unrestrict', pairs[0][1]), 'recovery_dump_format_invalid')
    return re.sub(rb'^\\(?:unrestrict|restrict) [A-Za-z0-9]+\r?\n', b'', raw, flags=re.M)


def validate_profile(profile):
    keys(profile, 'kind legacySecurity cmsCatalogs witness readiness topology')
    require(profile['kind'] == 'production-b0-recovery-profile-v1')
    require(isinstance(profile['cmsCatalogs'], list) and len(profile['cmsCatalogs']) == 7)
    for digest in profile['cmsCatalogs']:
        hash_value(digest)
    witness = profile['witness']
    keys(witness, 'profileSha256 sshSha256 configSha256 knownHostsSha256 routes')
    for name in ('profileSha256', 'sshSha256', 'configSha256', 'knownHostsSha256'):
        hash_value(witness[name])
    require(isinstance(witness['routes'], list) and len(witness['routes']) == 3)
    for route, expected in zip(ROUTES, witness['routes']):
        keys(expected, 'route status bodySha256')
        require(expected['route'] == route and type(expected['status']) is int and expected['status'] in (403, 404, 503))
        hash_value(expected['bodySha256'])
    ready = profile['readiness']
    keys(ready, 'apiEnvironmentSha256 cronEnvironmentSha256 egressRulesSha256 egressNetworkId uid uploadPath uploadSha256')
    for name in ('apiEnvironmentSha256', 'cronEnvironmentSha256', 'egressRulesSha256', 'egressNetworkId', 'uploadSha256'):
        hash_value(ready[name])
    require(isinstance(ready['uid'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', ready['uid']))
    require(isinstance(ready['uploadPath'], str) and re.fullmatch(r'/uploads/[0-9a-f-]{36}\.webp', ready['uploadPath']))
    topology = profile['topology']
    keys(topology, 'networks sourceContainers externalEndpoints hostListenersSha256')
    hash_value(topology['hostListenersSha256'])
    keys(topology['sourceContainers'], 'api cron nginx postgres')
    for digest in topology['sourceContainers'].values():
        hash_value(digest)
    require(isinstance(topology['networks'], list) and len(topology['networks']) == 3)
    for network in topology['networks']:
        keys(network, 'Id Name Driver Internal Options IPAM')
        hash_value(network['Id'])
        require(network['Driver'] == 'bridge' and type(network['Internal']) is bool)
    require({n['Name'] for n in topology['networks']} == {'ownerinc-portal-backend','ownerinc-portal-egress','ownerinc_proxy'})
    require(len({n['Id'] for n in topology['networks']}) == 3 and
            next(n for n in topology['networks'] if n['Name']=='ownerinc-portal-backend')['Internal'] is True and
            next(n for n in topology['networks'] if n['Name']=='ownerinc-portal-egress')['Id'] == ready['egressNetworkId'])
    require(isinstance(topology['externalEndpoints'], list))
    for endpoint in topology['externalEndpoints']:
        keys(endpoint, 'network id')
        require(endpoint['network'] == 'ownerinc_proxy')
        hash_value(endpoint['id'])
    return profile


def cms_prefix(migrations, relations, rows, catalog_hash, profile, expected_migrations):
    # No existing authenticated history chain proves non-use after native DDL.
    # UUID INSERT/COMMIT/DELETE need not change any of these observations. Neither
    # a matching catalog nor unused sequences may authorize history erasure.
    require(not migrations and set(relations) <= {'payload_migrations'},
            'recovery_native_history_unprovable')
    require(isinstance(migrations, list) and len(migrations) <= len(expected_migrations) and
            migrations == expected_migrations[:len(migrations)], 'recovery_cms_prefix_unknown')
    expected = CMS_PREFIXES[len(migrations)]
    # Payload can create its migration ledger before the first native migration.
    allowed = (expected, {'payload_migrations'}) if not migrations else (expected,)
    require(set(relations) in allowed and set(rows) == set(relations), 'recovery_cms_prefix_unknown')
    require(catalog_hash == profile['cmsCatalogs'][len(migrations)], 'recovery_cms_catalog_changed')
    for name, count in rows.items():
        require(type(count) is int and count >= 0)
        require(count == (len(migrations) if name == 'payload_migrations' else 0), 'recovery_native_content_present')
    return len(migrations)


def validate_contract(contract, intent, baseline, profile_sha):
    keys(contract, 'kind installBindingSha256 baselineProofSha256 profileSha256 archiveManifestSha256 source restored sourceLayoutSha256 cloneEvidenceSha256 procedureRevision')
    require(contract['kind'] == 'production-exact-b0-recovery-contract-v1' and
            contract['installBindingSha256'] == value_hash(intent['binding']) and
            contract['baselineProofSha256'] == intent['b0RecoveryBaseline']['proofSha256'] and
            contract['profileSha256'] == profile_sha and
            contract['archiveManifestSha256'] == baseline['manifestSha256'] and
            contract['source'] == baseline['database'] and
            contract['sourceLayoutSha256'] == baseline['database']['layoutSha256'])
    for name in ('cloneEvidenceSha256', 'procedureRevision'):
        hash_value(contract[name])
    for item in (contract['source'], contract['restored']):
        validate_tuple(item)
    # Only the same enumerated object/column layout is supported initially.
    # No speculative candidate-only DROP plan is executed by this profile.
    require(contract['restored']['layoutSha256'] == contract['sourceLayoutSha256'] and
            contract['restored']['identity'] == contract['source']['identity'] and
            contract['restored']['dataSha256'] == contract['source']['dataSha256'] and
            contract['restored']['rolesSha256'] == contract['source']['rolesSha256'] and
            contract['restored']['catalogSha256'] == contract['source']['catalogSha256'] and
            contract['restored']['securitySha256'] == contract['source']['securitySha256'])
    return contract


def validate_clone_measurements(evidence, baseline, restored=None):
    """Measurements from independently authenticated exact-archive clone qualification."""
    keys(evidence, 'kind manifestSha256 archiveSchemaSha256 catalogSha256 layoutSha256 dataSha256 securitySha256 rolesSha256 uploadsSha256 databaseAclSha256')
    require(evidence['kind'] == 'production-b0-recovery-clone-measurements-v1')
    require(evidence['manifestSha256'] == baseline['manifestSha256'] and
            evidence['archiveSchemaSha256'] == baseline['archiveSchemaSha256'] and
            evidence['uploadsSha256'] == value_hash(baseline['uploads']), 'recovery_clone_correspondence_failed')
    for field in ('catalogSha256','layoutSha256','dataSha256','securitySha256','rolesSha256'):
        require(evidence[field] == baseline['database'][field], 'recovery_clone_correspondence_failed')
    hash_value(evidence['databaseAclSha256'])
    if restored is not None:
        require(evidence['databaseAclSha256'] == restored['databaseAclSha256'])


def validate_tuple(value):
    keys(value, 'identity catalogSha256 layoutSha256 dataSha256 securitySha256 rolesSha256 databaseAclSha256')
    keys(value['identity'], 'systemIdentifier databaseOid databaseName')
    for field,pattern in (('systemIdentifier',r'[0-9]{1,32}'),('databaseOid',r'[0-9]{1,12}'),
                          ('databaseName',r'[a-z_][a-z0-9_]{0,62}')):
        require(isinstance(value['identity'][field],str) and re.fullmatch(pattern,value['identity'][field]))
    for name in set(value) - {'identity'}:
        hash_value(value[name])
    return value


def classify_database(actual, restored, previous):
    validate_tuple(actual); validate_tuple(restored); validate_tuple(previous)
    if actual == restored:
        return 'restored'
    if actual == previous:
        return 'previous'
    raise RecoveryError('recovery_database_unknown')


def make_plan(state, head, contract_sha):
    intent = state['installIntent']
    return {'kind': 'production-prefloor-recovery-plan-v1', 'installBindingSha256': value_hash(intent['binding']),
        'originStateSha256': head, 'originInstallStage': intent['stage'],
        'b0AcceptanceSha256': intent['b0Acceptance']['decisionSha256'],
        'baselineProofSha256': intent['b0RecoveryBaseline']['proofSha256'], 'contractSha256': contract_sha}


def container_projection(container):
    return {name:container[name] for name in ('Id','Created','Config','HostConfig','Mounts')}


def linux_path(path):
    require(isinstance(path,str) and path.startswith('/') and len(path) <= 4096 and
            not any(c in path for c in ('\0','\n','\r')) and len(path.split('/')) <= 256,
            'recovery_mount_source_invalid')
    return '/' + posixpath.normpath(path).lstrip('/')


def path_contains(parent, child):
    return posixpath.commonpath((parent,child)) == parent


class LinuxMounts:
    """Bounded mount-table + no-follow ancestry observations, not a tree scan.

    Bind aliases map to the same (device, filesystem-root/subpath). Include
    nested mounts exposed by an ancestor bind. Ambiguous/unsupported topology
    refuses; never interpret realpath as evidence of a kernel bind relationship.
    """
    @staticmethod
    def parse(raw):
        require(isinstance(raw,bytes) and len(raw) <= 4*1024*1024, 'recovery_mount_topology_ambiguous')
        rows = raw.decode('utf8','strict').splitlines()
        require(0 < len(rows) <= 16384, 'recovery_mount_topology_ambiguous')
        result = []
        def unescape(value):
            value = re.sub(r'\\(040|011|012|134)',lambda m:chr(int(m[1],8)),value)
            return linux_path(value)
        for line in rows:
            parts = line.split(' ')
            require(parts.count('-') == 1, 'recovery_mount_topology_ambiguous')
            split = parts.index('-')
            require(split >= 6 and len(parts) == split+4 and
                    re.fullmatch('[0-9]+:[0-9]+',parts[2]) and
                    parts[0].isdigit() and parts[1].isdigit(), 'recovery_mount_topology_ambiguous')
            result.append({'id':int(parts[0]),'parent':int(parts[1]),'device':parts[2],
                'root':unescape(parts[3]),'path':unescape(parts[4]),'fs':parts[split+1]})
        require(len({r['id'] for r in result}) == len(result) and
                len({r['path'] for r in result}) == len(result) and
                any(r['path']=='/' for r in result), 'recovery_mount_topology_ambiguous')
        return result

    @staticmethod
    def namespace():
        require(sys.platform == 'linux', 'recovery_mount_namespace_unqualified')
        own = os.stat('/proc/self/ns/mnt')
        identity = (own.st_dev,own.st_ino)
        require(identity == (os.stat('/proc/1/ns/mnt').st_dev,os.stat('/proc/1/ns/mnt').st_ino),
                'recovery_mount_namespace_unqualified')
        # Docker inspect Sources are daemon-namespace paths. A local socket alone
        # does not prove the daemon observes this mount table.
        daemons = []
        with os.scandir('/proc') as entries:
            for index,entry in enumerate(entries):
                require(index < 32768, 'recovery_mount_namespace_unqualified')
                if not entry.name.isdigit(): continue
                try:
                    with open(entry.path+'/comm','rb') as stream: name=stream.read(64)
                    if name != b'dockerd\n': continue
                    require(entry.stat().st_uid == 0, 'recovery_mount_namespace_unqualified')
                    ns = os.stat(entry.path+'/ns/mnt')
                    require((ns.st_dev,ns.st_ino) == identity, 'recovery_mount_namespace_unqualified')
                    with open(entry.path+'/stat','rb') as stream: started=stream.read(4096).rsplit(b')',1)[1].split()[19].decode('ascii')
                    daemons.append((entry.name,started))
                except FileNotFoundError: continue
        require(len(daemons)==1, 'recovery_mount_namespace_unqualified')
        return identity,daemons

    @staticmethod
    def raw():
        with open('/proc/self/mountinfo','rb') as stream: return stream.read(4*1024*1024+1)

    def __init__(self):
        self.ns = self.namespace(); self.bytes = self.raw(); self.rows = self.parse(self.bytes)
        self.paths = {}
        self.reaffirm()

    @staticmethod
    def open_path(path, root_fd=None):
        # Traverse ORIGINAL components: normalizing symlink/../ first would hide
        # a foreign symlink. O_PATH supports files as well as directories.
        linux_path(path)
        fd = os.open('/',os.O_PATH|os.O_DIRECTORY) if root_fd is None else os.dup(root_fd)
        identities = []
        try:
            for part in ['',*path.split('/')]:
                if part:
                    child = os.open(part,os.O_PATH|os.O_NOFOLLOW,dir_fd=fd)
                    os.close(fd); fd=child
                info = os.fstat(fd)
                require(not stat.S_ISLNK(info.st_mode), 'recovery_foreign_symlink')
                identities.append((info.st_dev,info.st_ino))
            return fd,identities
        except BaseException:
            os.close(fd);raise

    @staticmethod
    def ancestry(path):
        fd,identities=LinuxMounts.open_path(path)
        os.close(fd)
        return identities

    def coordinates(self, path):
        normalized = linux_path(path)
        if not hasattr(self,'coordinate_cache'): self.coordinate_cache={}
        if path in self.coordinate_cache: return self.coordinate_cache[path]
        require(len(self.paths)<4096, 'recovery_mount_topology_ambiguous')
        ancestry = self.ancestry(path)
        row = max((r for r in self.rows if path_contains(r['path'],normalized)),key=lambda r:len(r['path']))
        # Subvolume/overlay identities require more than dev/root; refuse them.
        require(row['fs'] in ('ext4','xfs','tmpfs'), 'recovery_mount_topology_ambiguous')
        require(row['device'] == str(os.major(ancestry[-1][0]))+':'+str(os.minor(ancestry[-1][0])),
                'recovery_mount_topology_changed')
        self.paths[path] = ancestry
        relative = posixpath.relpath(normalized,row['path'])
        result=row['device'],linux_path(posixpath.join(row['root'],relative))
        self.coordinate_cache[path]=result
        return result

    def regions(self, path):
        result = [self.coordinates(path)]
        for row in self.rows:
            if row['path'] != linux_path(path) and path_contains(linux_path(path),row['path']):
                result.append(self.coordinates(row['path']))
        return result

    def overlap(self, source, target):
        left,right = self.regions(source),self.regions(target)
        return any(a==b and (path_contains(x,y) or path_contains(y,x)) for a,x in left for b,y in right)

    def reaffirm(self):
        require(self.namespace()==self.ns and self.raw()==self.bytes, 'recovery_mount_topology_changed')
        for path,identity in self.paths.items():
            require(self.ancestry(path)==identity, 'recovery_mount_topology_changed')


def physical_paths_overlap(source, target, topology):
    return topology.overlap(source,target)


def container_mount_identity(container):
    state=container['State']
    return {'container':value_hash(container_projection(container)),
        'driver':container.get('GraphDriver'),
        'state':{key:state.get(key) for key in ('Pid','Running','Paused','Restarting','Dead','StartedAt','FinishedAt')}}


class ContainerMounts:
    """Observe EFFECTIVE mounts, pinned to the inspected container's live PID.

    A bind can outlive its host Source path. Mountinfo from that PID's namespace,
    not a second host-path lookup, is the evidence for its retained backing.
    """
    def __init__(self, container):
        state=container['State'];pid=state.get('Pid')
        require(type(pid) is int and 0 < pid <= 4194304 and state.get('Running') is True and
                not state.get('Restarting') and not state.get('Dead'), 'recovery_effective_mount_unprovable')
        self.pid=pid;self.container=container;self.descriptors=[];self.paths={}
        try:
            self.proc=os.open('/proc/'+str(pid),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            self.descriptors.append(self.proc)
            # These two procfs magic links are deliberately pinned; foreign
            # filesystem symlinks reached below the root descriptor never are.
            self.namespace=os.open('ns/mnt',os.O_RDONLY,dir_fd=self.proc)
            self.descriptors.append(self.namespace)
            self.root=os.open('root',os.O_PATH|os.O_DIRECTORY,dir_fd=self.proc)
            self.descriptors.append(self.root)
            self.start=self.read('stat',4096).rsplit(b')',1)[1].split()[19]
            self.cgroup=self.read('cgroup',65536)
            selectors={container['Id'],'docker-'+container['Id']+'.scope'}
            require(any(selectors.intersection(line.split(':',2)[-1].split('/'))
                        for line in self.cgroup.decode('ascii').splitlines()), 'recovery_effective_mount_unprovable')
            self.ns_identity=self.identity(os.fstat(self.namespace))
            self.root_identity=self.identity(os.fstat(self.root))
            self.raw=self.read('mountinfo',4*1024*1024)
            self.rows=LinuxMounts.parse(self.raw)
            self.reaffirm()
        except BaseException:
            self.close();raise

    @staticmethod
    def identity(info): return info.st_dev,info.st_ino

    def read(self, name, cap):
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=self.proc)
        with os.fdopen(fd,'rb') as stream: raw=stream.read(cap+1)
        require(len(raw)<=cap,'recovery_effective_mount_unprovable')
        return raw

    def regions(self):
        # Every declared bind/volume must have a visible, verifiable effective
        # mount. Also inspect other physical mounts in the namespace, so an
        # unlisted nested bind cannot hide behind an otherwise unrelated source.
        supported=('ext4','xfs','tmpfs')
        for mount in self.container['Mounts']:
            if mount.get('Type') not in ('bind','volume'): continue
            destination=mount.get('Destination')
            require(linux_path(destination)==destination,'recovery_effective_mount_unprovable')
            matches=[r for r in self.rows if r['path']==destination]
            require(len(matches)==1 and matches[0]['fs'] in supported,'recovery_effective_mount_unprovable')
            fd,ancestry=LinuxMounts.open_path(destination,self.root)
            os.close(fd);self.paths[destination]=ancestry
            require(matches[0]['device']==str(os.major(ancestry[-1][0]))+':'+str(os.minor(ancestry[-1][0])),
                    'recovery_effective_mount_changed')
        result=[]
        pseudo=('proc','sysfs','devpts','mqueue','cgroup','cgroup2')
        for row in self.rows:
            if row['fs'] in supported: result.append((row['device'],row['root']))
            else:
                require(row['fs'] in pseudo or row['fs']=='overlay' and row['path']=='/' and
                        self.container.get('GraphDriver',{}).get('Name') in ('overlay2','overlayfs'),
                        'recovery_effective_mount_unprovable')
        return result

    def reaffirm(self):
        require(self.identity(os.stat('/proc/'+str(self.pid)))==self.identity(os.fstat(self.proc)) and
                self.read('stat',4096).rsplit(b')',1)[1].split()[19]==self.start and
                self.read('cgroup',65536)==self.cgroup and self.read('mountinfo',4*1024*1024)==self.raw and
                self.identity(os.stat('ns/mnt',dir_fd=self.proc))==self.ns_identity and
                self.identity(os.stat('root',dir_fd=self.proc))==self.root_identity,
                'recovery_effective_mount_changed')
        for path,expected in self.paths.items():
            fd,actual=LinuxMounts.open_path(path,self.root);os.close(fd)
            require(actual==expected,'recovery_effective_mount_changed')

    def close(self):
        for fd in reversed(self.descriptors): os.close(fd)
        self.descriptors=[]


def verify_effective_container_mounts(container, topology, mountpoints, inspect_container):
    require(callable(inspect_container),'recovery_effective_mount_unprovable')
    before=container_mount_identity(container)
    effective=None
    try:
        state=container['State']
        require(not state.get('Restarting') and not state.get('Dead'),'recovery_effective_mount_unprovable')
        if state.get('Running') is True:
            require(container['HostConfig'].get('Privileged') is False and
                    not any(cap.upper() in ('SYS_ADMIN','CAP_SYS_ADMIN','ALL') for cap in container['HostConfig'].get('CapAdd') or []),
                    'recovery_effective_mount_unprovable')
            effective=ContainerMounts(container)
            protected=[region for path in mountpoints for region in topology.regions(path)]
            require(not any(a==b and (path_contains(x,y) or path_contains(y,x))
                for a,x in effective.regions() for b,y in protected),'recovery_foreign_consumer')
        else:
            require(state.get('Running') is False and state.get('Pid')==0,'recovery_effective_mount_unprovable')
        current=inspect_container(container['Id'])
        require(isinstance(current,list) and len(current)==1 and current[0]['Id']==container['Id'] and
                container_mount_identity(current[0])==before,'recovery_effective_mount_changed')
        if effective: effective.reaffirm()
    except OSError:
        raise RecoveryError('recovery_effective_mount_unprovable') from None
    finally:
        if effective: effective.close()


def volume_backing_paths(volume):
    require(volume.get('Driver') == 'local' and volume.get('Scope') == 'local', 'recovery_volume_driver_unsupported')
    paths = [volume.get('Mountpoint')]
    options = volume.get('Options') or {}
    if options:
        require(set(options) <= {'type','device','o'} and options.get('type','') in ('','none') and
                isinstance(options.get('o'),str) and set(options['o'].split(',')) <= {'bind','rbind','rw','ro'} and
                set(options['o'].split(',')) & {'bind','rbind'}, 'recovery_volume_driver_unsupported')
        paths.append(options.get('device'))
    for path in paths:
        require(isinstance(path,str) and path.startswith('/'), 'recovery_mount_source_invalid')
    return paths


def reject_foreign_resource_access(containers, project, volumes, mountpoints, decision=None, volume_sources=None, inspect_container=None):
    """Inspect ALL mounts/namespaces before the ordinary relevance filter.

    Stopped/restarting containers are not adopted. Read-only binds still expose
    protected resources and never authorize sharing their namespaces.
    """
    topology = LinuxMounts()
    for path in mountpoints: topology.regions(path)
    trusted, touching = set(), set()
    for container in containers:
        labels = container['Config'].get('Labels') or {}
        owned = labels.get('com.docker.compose.project') == project or (
            decision is not None and labels.get('io.ownerinc.b0-recovery') == decision)
        if owned:
            trusted.add(container['Id'])
        for mount in container['Mounts']:
            matched = mount.get('Name') in volumes
            if mount.get('Type') in ('bind','volume') or mount.get('Source'):
                source = mount.get('Source')
                require(isinstance(source,str) and source.startswith('/'), 'recovery_mount_source_invalid')
                sources = [source, *(volume_sources or {}).get(mount.get('Name'),[])]
                overlaps = [physical_paths_overlap(source,path,topology) for source in sources for path in mountpoints]
                matched = matched or any(overlaps)
            if matched:
                touching.add(container['Id'])
                require(owned, 'recovery_foreign_consumer')
    protected = trusted | touching
    edges = []
    for container in containers:
        for field in ('NetworkMode','PidMode','IpcMode'):
            mode = container['HostConfig'].get(field,'') or ''
            if mode.startswith('container:'):
                target = mode[len('container:'):]
                matches = [c['Id'] for c in containers if target == c.get('Name','').lstrip('/') or
                    target == c['Id'] or len(target) >= 12 and re.fullmatch('[0-9a-f]+',target) and c['Id'].startswith(target)]
                require(len(matches) == 1, 'recovery_namespace_target_unknown')
                edges.append((container['Id'],matches[0]))
    changed = True
    while changed:
        changed = False
        for left,right in edges:
            if left in protected or right in protected:
                require(left in trusted and right in trusted, 'recovery_foreign_namespace')
                before = len(protected); protected.update((left,right)); changed |= len(protected) != before
    for container in containers:
        if container['Id'] not in trusted:
            verify_effective_container_mounts(container,topology,mountpoints,inspect_container)
    topology.reaffirm()


def readiness_token(raw):
    require(isinstance(raw,bytes) and 101 <= len(raw) <= 16384 and raw.endswith(b'\n') and
            re.fullmatch(rb'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n',raw),
            'recovery_readiness_token_invalid')
    return raw[:-1].decode('ascii')


DB_PROBE = r"""const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
try{await c.connect();await c.query('BEGIN READ ONLY');await c.query('SET LOCAL statement_timeout=5000');
const r=await c.query("SELECT current_database() AS database, current_user AS role, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid");
await c.query('ROLLBACK');process.stdout.write(JSON.stringify(r.rows[0]));}finally{await c.end();}})().catch(()=>process.exit(2));"""
API_PROBE = r"""const http=require('http'),crypto=require('crypto');let input='';
process.stdin.on('data',b=>{input+=b;if(input.length>16384)process.exit(2)});
process.stdin.on('end',async()=>{try{const p=JSON.parse(input);
const get=path=>new Promise((resolve,reject)=>{const r=http.get({hostname:'127.0.0.1',port:3000,path,
headers:{Authorization:'Bearer '+p.token}},s=>{let chunks=[],size=0;s.on('data',b=>{size+=b.length;if(size>4194304)r.destroy();else chunks.push(b)});
s.on('end',()=>s.statusCode===200?resolve(Buffer.concat(chunks)):reject(Error('status')))});r.setTimeout(5000,()=>r.destroy());r.on('error',reject)});
if(JSON.parse(await get('/api/ready')).status!=='ready')throw Error('ready');
if(JSON.parse(await get('/api/users/me')).uid!==p.uid)throw Error('uid');
if(crypto.createHash('sha256').update(await get(p.uploadPath)).digest('hex')!==p.uploadSha256)throw Error('upload');
process.stdout.write(JSON.stringify({ready:true,authenticatedRead:true,uploadRead:true}));}catch{process.exit(2)}});"""


def bounded_command(args, *, data=None, source=None, output=None, limit=CAP, timeout=30):
    """Fixed internal argv only. Bound outputs/time without retaining dump in RAM."""
    require(isinstance(args, list) and all(isinstance(x, str) and '\0' not in x for x in args))
    require(not (data is not None and source is not None))
    with tempfile.TemporaryFile() as stdin, tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        if data is not None:
            stdin.write(data); stdin.seek(0)
        target = output if output is not None else stdout
        process = subprocess.Popen(args, stdin=source if source is not None else stdin, stdout=target,
            stderr=stderr, shell=False, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
            # Inherit the ADMIN supervisor's process group. A nested session
            # would escape its timeout/grandchild cleanup.
            start_new_session=False,
            **({'pass_fds': (9,)} if os.name != 'nt' else {}))
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                require(time.monotonic() < deadline and os.fstat(target.fileno()).st_size <= limit and
                        os.fstat(stderr.fileno()).st_size <= CAP, 'recovery_command_budget')
                time.sleep(0.02)
            require(process.returncode == 0 and os.fstat(target.fileno()).st_size <= limit and
                    os.fstat(stderr.fileno()).st_size <= CAP,
                    'recovery_command_failed')
            if output is None:
                stdout.seek(0); return stdout.read(limit + 1)
        finally:
            if process.poll() is None:
                process.kill()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os._exit(2)  # Retain inherited lease until kernel closes this process.


IDENTITY_SQL = """SELECT json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'databaseName',current_database());"""
LAYOUT_SQL = """SELECT json_build_object('relations',(SELECT coalesce(json_agg(row(n.nspname,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) END)::text
ORDER BY n.nspname,c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'), 'columns',(SELECT coalesce(json_agg(row(c.relname,a.attname,a.atttypid::regtype::text,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,
(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))::text
ORDER BY c.relname,a.attnum),'[]') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
'routines',(SELECT coalesce(json_agg(row(p.proname,pg_get_function_identity_arguments(p.oid),p.prokind,
CASE WHEN p.prokind<>'a' THEN pg_get_functiondef(p.oid) END)::text ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)),'[]')
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
'types',(SELECT coalesce(json_agg(row(t.typname,t.typtype,t.typcategory,t.typbasetype::regtype::text,t.typtypmod,
(SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))::text ORDER BY t.typname),'[]')
FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'),
'constraints',(SELECT coalesce(json_agg(row(c.conname,c.conrelid::regclass::text,pg_get_constraintdef(c.oid))::text
ORDER BY c.conrelid::regclass::text,c.conname),'[]') FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
'indexes',(SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid) ORDER BY c.relname),'[]') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
'triggers',(SELECT coalesce(json_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
'schemaSecurity',(SELECT coalesce(json_agg(row(n.nspname,pg_get_userbyid(n.nspowner),n.nspacl)::text ORDER BY n.nspname),'[]')
FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'),
'defaultAcls',(SELECT coalesce(json_agg(row(pg_get_userbyid(a.defaclrole),coalesce(n.nspname,''),a.defaclobjtype,a.defaclacl)::text
ORDER BY pg_get_userbyid(a.defaclrole),coalesce(n.nspname,''),a.defaclobjtype),'[]') FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace),
'extensions',(SELECT coalesce(json_agg(row(e.extname,e.extversion,n.nspname)::text ORDER BY e.extname),'[]') FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace));"""
DATABASE_ACL_SQL = """SELECT json_build_object('owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
'acl',(SELECT coalesce(json_agg(row(pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
x.privilege_type,x.is_grantable)::text ORDER BY x.grantor,x.grantee,x.privilege_type),'[]') FROM pg_database d,
LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) x WHERE d.datname=current_database()));"""
QUIET_SQL = """SELECT json_build_object('clients',(SELECT count(*) FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database
WHERE datname=current_database()) AND pid<>pg_backend_pid() AND backend_type='client backend'),
'prepared',(SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database()),
'subscriptions',(SELECT count(*) FROM pg_subscription), 'recovery',pg_is_in_recovery(),
'extensions',(SELECT coalesce(json_agg(extname ORDER BY extname),'[]') FROM pg_extension),
'preload',current_setting('shared_preload_libraries'));
"""


# pg_restore --clean only removes archive members. Exclude dumpable classes not
# represented by the public-object layout, plus external-effect infrastructure.
# No caller-selected deletion plan or catalog rewrite is accepted.
UNSUPPORTED_SQL = """SELECT json_build_object(
'publication',(SELECT count(*) FROM pg_publication),
'subscription',(SELECT count(*) FROM pg_subscription),
'foreignInfrastructure',(SELECT (SELECT count(*) FROM pg_foreign_server)+(SELECT count(*) FROM pg_user_mapping)+(SELECT count(*) FROM pg_foreign_data_wrapper)),
'eventTrigger',(SELECT count(*) FROM pg_event_trigger),
'extendedStatistics',(SELECT count(*) FROM pg_statistic_ext),
'textSearch',(SELECT (SELECT count(*) FROM pg_ts_config WHERE cfgnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_ts_dict WHERE dictnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_ts_parser WHERE prsnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_ts_template WHERE tmplnamespace<>'pg_catalog'::regnamespace)),
'collationConversion',(SELECT (SELECT count(*) FROM pg_collation WHERE collnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_conversion WHERE connamespace<>'pg_catalog'::regnamespace)),
'operatorInfrastructure',(SELECT (SELECT count(*) FROM pg_operator WHERE oprnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_opclass WHERE opcnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_opfamily WHERE opfnamespace<>'pg_catalog'::regnamespace)+(SELECT count(*) FROM pg_am WHERE oid>=16384)),
'castTransformLanguage',(SELECT (SELECT count(*) FROM pg_cast WHERE oid>=16384)+(SELECT count(*) FROM pg_transform)+(SELECT count(*) FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql'))),
'securityLabels',(SELECT count(*) FROM pg_seclabel),
'databaseSettings',(SELECT count(*) FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())),
'logicalReplication',(SELECT (SELECT count(*) FROM pg_replication_slots WHERE database=current_database())+(SELECT count(*) FROM pg_replication_origin)));
"""
UNSUPPORTED_CLASSES = ('publication','subscription','foreignInfrastructure','eventTrigger','extendedStatistics',
    'textSearch','collationConversion','operatorInfrastructure','castTransformLanguage','securityLabels','databaseSettings','logicalReplication')


class ProductionHost:
    def __init__(self, launcher, captured, material, receipt):
        self.l, self.material = launcher, material
        self.r = launcher.load_runtime_captured(captured); self.s = self.r.STATE
        self.storage = launcher.load_authenticated(captured['ops/payload-recovery-storage.py'],
            launcher.ROOT + '/ops/payload-recovery-storage.py')
        self.inventory = self.r._inventory(force=True)['document']
        self.root = launcher.RUNTIME
        self.receipt = receipt
        self.reload()
        require(self.s.recovery_capable_binding(self.binding) and self.binding['receiptId'] == receipt,
                'recovery_closure_before_reservation_required')
        require(self.binding['preparationClosureSha256'] == value_hash(material[0]['source']))
        self.profile_raw = launcher.protected(PROFILE, 0o600, CAP)
        self.profile = validate_profile(self.s.parse_canonical(self.profile_raw, 'recovery_profile_invalid'))
        require(sha(self.profile_raw) == material[0]['hostBaseline'].get('recoveryProfileSha256'), 'recovery_profile_unapproved')
        self.base = os.path.join(self.root, 'payload-b0-recovery-' + self.binding['receiptId'])
        self.baseline_path = os.path.join(self.base, 'baseline.json')
        self.dbname = self.binding['portalTarget']['database']['databaseName']
        self.pg = None

    def reload(self):
        self.key, _, self.body, self.head = self.s.read_state(self.root, repair_head=False)
        self.intent = self.body.get('installIntent')
        require(self.intent is not None)
        self.binding = self.intent['binding']

    def authenticate(self):
        self.l.verify_inherited_lease()
        material = self.l._authenticated_material()
        require(material[4] == self.material[4] and material[5] == self.material[5])
        self.reload()
        self.s.validate_production_correspondence(self.binding, material[0], material[5], self.inventory,
            {'sourceApprovalSha256': self.l.approval_binding_digest(material[0]),
             'policySha256': material[0]['admission']['policySha256'], 'recordSha256': material[0]['admission']['recordSha256']})
        require(self.s.recovery_capable_binding(self.binding) and self.intent['stage'] in self.s.PRODUCTION_INSTALL_STAGES and
            self.body['authority'] == {'mode': 'legacy', 'epoch': 1} and self.body['admission'] == 'closed' and
            self.body['workerHold'] is True and self.body['restoreIntent'] is None and
            self.body['rollbackTargetImages'] is None and self.body['cmsStatus'] != 'migrated')
        require(self.l.host_read(self.inventory['paths']['currentRelease'], (0, 0), (0o600,)).strip().decode() == self.binding['sourceRelease'])
        self.r._sentinel(self.root, expected=True)
        require(self.l.protected(PROFILE, 0o600, CAP) == self.profile_raw)
        require({'device': os.fstat(9).st_dev, 'inode': os.fstat(9).st_ino} == self.binding['lease'])

    def command(self, args, **options):
        return bounded_command(args, **options)

    def docker_json(self, *args):
        return self.r._strict_json(self.command(['/usr/bin/docker', *args]), 'recovery_docker_response_invalid')

    def sql(self, text, database=None):
        require(self.pg is not None)
        raw = self.command(['/usr/bin/docker', 'exec', '-i', self.pg, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
            '--username=portal_admin', '--dbname=' + (database or self.dbname)],
            data=('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout=20000; '
                  'SET LOCAL lock_timeout=2000; SET LOCAL search_path=pg_catalog;\n' + text + '\nROLLBACK;\n').encode())
        return self.r._strict_json(raw.strip(), 'recovery_database_response_invalid')

    def dump(self, database=None, schema=False, output=None):
        args = ['/usr/bin/docker', 'exec', self.pg, 'pg_dump', '--username=portal_admin', '--dbname=' + (database or self.dbname)]
        args += ['--schema-only'] if schema else ['--format=custom']
        return self.command(args, output=output, limit=CAP if schema else 256 * 1024 ** 3, timeout=600)

    def security(self):
        query = self.r.portal_legacy_security_observation_sql().strip()
        prefix, suffix = 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;', 'ROLLBACK;'
        require(query.startswith(prefix) and query.endswith(suffix))
        value = self.sql(query[len(prefix):-len(suffix)])
        return self.r.validate_portal_legacy_security_observation(value, self.dbname)

    def database_tuple(self):
        self.supported_layout()
        observation = self.security()
        require(not any(row['kind'] == 'guard' and row['present'] or
                        row['kind'] == 'object' and row['unsupported'] for row in observation['records']),
                'recovery_security_mechanism_unsupported')
        roles = [row for row in observation['records'] if row['kind'] in ('role', 'membership', 'settings')]
        for row in roles:
            require(row['kind'] == 'role' and row['login'] and not any(row[k] for k in
                ('superuser', 'createDatabase', 'createRole', 'replication', 'bypassRls')) or
                row['kind'] == 'settings' and not row['present'], 'recovery_role_drift')
        # Database ACL is deliberately separate: keep its current CMS CONNECT fence.
        object_security = [row for row in observation['records'] if row.get('objectType') != 'database']
        return validate_tuple({'identity': self.sql(IDENTITY_SQL),
            'catalogSha256': sha(normalize_dump(self.dump(schema=True))), 'layoutSha256': value_hash(self.sql(LAYOUT_SQL)),
            'dataSha256': self.r._data_fingerprint('postgres', self.dbname,
                isolated_query=lambda query: self.command(['/usr/bin/docker','exec','-i',self.pg,'psql','-XqAt','-v','ON_ERROR_STOP=1',
                    '--username=portal_admin','--dbname=' + self.dbname], data=(
                    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout=20000;\n' + query + '\nROLLBACK;').encode())),
            'securitySha256': value_hash(object_security), 'rolesSha256': value_hash(roles),
            'databaseAclSha256': value_hash(self.sql(DATABASE_ACL_SQL))})

    def quiet(self, database=None):
        value = self.sql(QUIET_SQL, database)
        require(value['clients'] == value['prepared'] == value['subscriptions'] == 0 and value['recovery'] is False and
                value['preload'] == '' and set(value['extensions']) <= {'plpgsql', 'pgcrypto'}, 'recovery_database_busy')

    def supported_layout(self):
        require(self.sql(UNSUPPORTED_SQL) == {name:0 for name in UNSUPPORTED_CLASSES},
                'recovery_object_class_unsupported')

    def witness(self):
        profile = self.profile['witness']
        for path, field, mode, cap in (('/usr/bin/ssh','sshSha256',0o755,200 * CAP),
            (SSH_CONFIG,'configSha256',0o600,CAP),(KNOWN_HOSTS,'knownHostsSha256',0o600,CAP)):
            require(sha(self.l.protected(path, mode, cap)) == profile[field], 'recovery_witness_trust_changed')
        context = {'stateSha256': self.head, 'installBindingSha256': value_hash(self.binding),
            'pid': os.getpid(), 'processStart': open('/proc/self/stat', encoding='ascii').read().rsplit(')',1)[1].split()[19],
            'device': os.fstat(9).st_dev, 'inode': os.fstat(9).st_ino}
        request = {'kind': 'production-b0-witness-request-v1', 'nonce': secrets.token_hex(32),
            'contextSha256': value_hash(context), 'profileSha256': profile['profileSha256']}
        started = time.monotonic()
        raw = self.command(['/usr/bin/ssh', '-F', SSH_CONFIG, '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
            '-oUserKnownHostsFile=' + KNOWN_HOSTS, '-oClearAllForwardings=yes', '-oRequestTTY=no',
            '-oGlobalKnownHostsFile=/dev/null', '-oVerifyHostKeyDNS=no', '-oUpdateHostKeys=no',
            '-oHostKeyAlias=ownerinc-payload-fence-witness',
            '-oPermitLocalCommand=no', '-oRemoteCommand=none', '-oProxyCommand=none', '-oProxyJump=none',
            '-oControlPath=none', '-oControlMaster=no', '-oConnectTimeout=5', '-T', 'ownerinc-payload-fence-witness'],
            data=canonical(request) + b'\n', limit=4096, timeout=20)
        value = self.s.parse_canonical(raw, 'recovery_witness_invalid')
        keys(value, 'kind nonce contextSha256 profileSha256 routes')
        require(time.monotonic() - started < 30 and value == dict(request,
            kind='production-b0-witness-response-v1', routes=profile['routes']), 'recovery_witness_mismatch')
        return value_hash(value)

    def resources(self, readiness=False, allow_cms=False):
        require(self.docker_json('context','inspect','--format','{{json .Endpoints.docker.Host}}') == 'unix:///var/run/docker.sock')
        raw = self.command(['/usr/bin/docker','ps','--all','--no-trunc','--format','{{.ID}}'])
        ids = raw.decode('ascii').splitlines(); require(len(ids) <= 512 and all(HEX.fullmatch(i) for i in ids))
        all_containers = self.docker_json('inspect', *ids) if ids else []
        volumes = {v['name'] for v in self.binding['portalTarget']['volumes'].values()}
        volumes.add(self.inventory['volumes']['cmsUploads']['name'])
        physical = [*self.binding['portalTarget']['volumes'].values(), *self.intent['creation']['volumes'].values()]
        for expected in physical:
            require(self.r._volume_info(expected['name']) == expected, 'restore_target_changed')
        names = {m['Name'] for c in all_containers for m in c['Mounts'] if m.get('Type') == 'volume' and m.get('Name')}
        names.update(v['name'] for v in physical)
        volume_sources = {}
        for name in names:
            raw = self.docker_json('volume','inspect',name)
            require(isinstance(raw,list) and len(raw) == 1 and raw[0].get('Name') == name)
            volume_sources[name] = volume_backing_paths(raw[0])
            for expected in physical:
                if name == expected['name']:
                    require(self.r._volume_receipt(raw[0]) == expected, 'restore_target_changed')
        reject_foreign_resource_access(all_containers,self.inventory['project'],volumes,
            [path for v in physical for path in volume_sources[v['name']]],
            self.decision_digest() if readiness else None, volume_sources,
            lambda identifier:self.docker_json('inspect',identifier))
        containers, pg = [], []
        for container in all_containers:
            config = container['Config']; labels = config.get('Labels') or {}
            relevant = labels.get('com.docker.compose.project') == self.inventory['project'] or any(
                m.get('Name') in volumes for m in container['Mounts'])
            recovery_owned = labels.get('io.ownerinc.b0-recovery') == self.decision_digest() if readiness else False
            if not relevant and not recovery_owned:
                # An unapproved container cannot quietly reuse a Portal role.
                for variable in config.get('Env') or []:
                    _,_,value = variable.partition('=')
                    if value.startswith(('postgres://','postgresql://')):
                        require(unquote(urlsplit(value).username or '') not in ('portal_api','portal_cron'),
                                'recovery_foreign_role_consumer')
                continue
            service = labels.get('com.docker.compose.service')
            require(recovery_owned or labels.get('com.docker.compose.project') == self.inventory['project'], 'recovery_foreign_consumer')
            status = container['State']
            require(not any(status.get(k) for k in ('Paused','Restarting','Dead')), 'recovery_writer_state')
            if service == 'postgres' and not recovery_owned:
                require(status['Running'] and config['Image'] == PG_IMAGE); pg.append(container['Id'])
            elif status['Running']:
                require(recovery_owned or allow_cms and service == 'cms' and
                        container['Id'] == self.intent['creation']['containers'].get('cms',{}).get('id'), 'recovery_writer_running')
            require((not container['HostConfig'].get('PortBindings') or service == 'nginx' and not status['Running']) and
                    container['HostConfig']['NetworkMode'] not in ('host',) and
                    not container['HostConfig']['NetworkMode'].startswith('container:'), 'recovery_alternative_ingress')
            if recovery_owned:
                self.verify_application_container(container, labels.get('io.ownerinc.b0-service'))
            elif service in self.intent['creation']['containers']:
                receipt = self.intent['creation']['containers'][service]
                require(container['Id'] == receipt['id'] and config['Image'] == receipt['image'], 'recovery_creator_receipt_changed')
                actual = self.r.production_container_fingerprint(container,self.binding['candidateRelease'])
                require(actual == receipt['fingerprint'], 'recovery_creator_receipt_changed')
            else:
                require(service in ('postgres','api','cron','nginx'), 'recovery_unreceipted_resource')
                require(value_hash(container_projection(container)) == self.profile['topology']['sourceContainers'][service],
                        'recovery_source_container_changed')
                if service in ('api','cron'):
                    source_env = dict(v.split('=',1) for v in config.get('Env') or [])
                    require(source_env.get('DATABASE_URL') == self.environments()[service][0]['DATABASE_URL'],
                            'recovery_previous_credentials_changed')
            containers.append({'id': container['Id'], 'service': service, 'image': config['Image'],
                'mounts': container['Mounts'], 'networks': sorted(container['NetworkSettings']['Networks']),
                'running': status['Running']})
        require(len(pg) == 1); self.pg = pg[0]
        require({c['service'] for c in containers} >= {'postgres','api','cron','nginx'}, 'recovery_service_missing')
        relevant_ids = {c['id'] for c in containers}
        for approved in self.profile['topology']['networks']:
            actual = self.docker_json('network','inspect',approved['Id'])
            require(isinstance(actual,list) and len(actual) == 1)
            actual = actual[0]
            require({k:actual[k] for k in approved} == approved, 'recovery_network_changed')
            allowed = relevant_ids | {e['id'] for e in self.profile['topology']['externalEndpoints'] if e['network'] == approved['Name']}
            require(set((actual.get('Containers') or {})) <= allowed, 'recovery_foreign_endpoint')
        allowed_networks = {n['Name'] for n in self.profile['topology']['networks']}
        require(all(set(c['networks']) <= allowed_networks for c in containers), 'recovery_network_changed')
        require(sha(self.command(['/usr/bin/ss','-H','-lntup'])) == self.profile['topology']['hostListenersSha256'],
                'recovery_host_listener_changed')
        require(sha(self.command(['/usr/sbin/nft','--stateless','list','ruleset'])) == self.profile['readiness']['egressRulesSha256'],
                'recovery_egress_changed')
        require(self.sql(IDENTITY_SQL) == self.binding['portalTarget']['database'], 'restore_target_changed')
        for key, expected in self.binding['portalTarget']['volumes'].items():
            require(self.r._volume_info(expected['name']) == expected, 'restore_target_changed')
        for key, expected in self.intent['creation']['volumes'].items():
            require(self.r._volume_info(expected['name']) == expected, 'restore_target_changed')
        names = self.command(['/usr/bin/docker','volume','ls','--format','{{.Name}}']).decode().splitlines()
        if self.inventory['volumes']['cmsUploads']['name'] in names:
            require('cmsUploads' in self.intent['creation']['volumes'], 'recovery_unreceipted_resource')
        return containers

    def cms_observation(self):
        present = self.sql("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='ownerinc_cms');")
        if not present:
            require(self.intent['cmsTarget'] is None, 'recovery_cms_missing')
            require(not self.intent['creation']['volumes'] and not self.intent['creation']['containers'],
                    'recovery_partial_resource_gap')
            require(self.sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('" + "','".join(CMS_ROLES) + "');") == 0,
                    'recovery_unreceipted_resource')
            return None
        require(self.intent['cmsTarget'] is not None, 'recovery_unreceipted_resource')
        require(self.sql(IDENTITY_SQL,'ownerinc_cms') == self.intent['cmsTarget']['database'])
        relations = self.sql("SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');",'ownerinc_cms')
        require(all(isinstance(n,str) and re.fullmatch('[a-z_][a-z0-9_]*',n) for n in relations))
        migrations = self.sql("SELECT coalesce(json_agg(name ORDER BY name),'[]') FROM public.payload_migrations;",'ownerinc_cms') if 'payload_migrations' in relations else []
        rows = {name: self.sql('SELECT count(*) FROM public."' + name + '";', 'ownerinc_cms') for name in relations}
        catalog = sha(normalize_dump(self.dump('ownerinc_cms', schema=True)))
        prefix = cms_prefix(migrations, relations, rows, catalog, self.profile, self.s.CMS_MIGRATIONS)
        sequences = self.sql("SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S';",'ownerinc_cms')
        for name in sequences:
            require(re.fullmatch('[a-z_][a-z0-9_]*',name))
            if name != 'payload_migrations_id_seq':
                require(self.sql('SELECT NOT is_called FROM public."' + name + '";','ownerinc_cms') is True,
                        'recovery_native_history_present')
        self.quiet('ownerinc_cms')
        require(self.sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'owner_news_%';",'ownerinc_cms') == 0)
        require(self.sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('" + "','".join(CMS_ROLES) +
            "') AND has_database_privilege(rolname,current_database(),'CONNECT');") == 0, 'recovery_cms_connect_fence')
        volume = self.intent['cmsTarget']['volumes']['cmsUploads']['mountpoint']
        uploads = self.storage.tree(volume)
        require(set(uploads) == {'.'}, 'recovery_native_media_present')
        return {'prefix': prefix, 'catalogSha256': catalog, 'uploadsSha256': value_hash(uploads),
                'identity': self.intent['cmsTarget']['database']}

    def boundary(self, readiness=False, allow_cms=False):
        self.authenticate()
        if getattr(self,'_b0_reaffirm',None) is not None:
            self._b0_reaffirm()
        first = self.resources(readiness, allow_cms)
        if not readiness and not allow_cms:
            self.quiet()
        if readiness:
            containers = self.application_containers()
            allowed = {(service,network.get('IPAddress')) for service,c in containers.items()
                       for network in c['NetworkSettings']['Networks'].values()}
            clients = self.sql("SELECT coalesce(json_agg(json_build_object('role',usename,'address',host(client_addr),'state',state,'transaction',xact_start IS NOT NULL)),'[]') FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend';")
            require(all((row['role'].removeprefix('portal_'),row['address']) in allowed and
                        row['state'] == 'idle' and row['transaction'] is False for row in clients), 'recovery_foreign_client')
            require(self.sql("SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database();") == 0)
        require(self.sql("SELECT count(*) FROM public.owner_news_authority WHERE singleton AND mode='legacy' AND epoch=1;") == 1)
        require(self.sql('SELECT count(*) FROM public.owner_news_authority_transitions;') == 0, 'recovery_native_history_present')
        # allow_cms affects quiescing only; it must never bypass eligibility.
        cms = self.cms_observation()
        witness = self.witness()
        second = self.resources(readiness, allow_cms)
        require(first == second, 'recovery_topology_changed')
        if getattr(self,'_b0_reaffirm',None) is not None:
            self._b0_reaffirm()
        return {'resources': first, 'cms': cms, 'witnessSha256': witness}

    def decision_digest(self):
        return self.intent.get('recovery',{}).get('binding',{}).get('decisionSha256')

    def environments(self):
        result = {}
        for service,path in ENV_FILES.items():
            raw = self.l.protected(path,0o600,CAP)
            require(sha(raw) == self.profile['readiness'][service + 'EnvironmentSha256'])
            entries = raw.decode('utf8').splitlines()
            require(all(re.fullmatch(r'[A-Z][A-Z0-9_]*=[^\r\n\0]*',line) for line in entries))
            values = dict(line.split('=',1) for line in entries)
            require(len(values) == len(entries) and values.get('NODE_ENV') == 'production' and
                    values.get('FIREBASE_AUTH_EMULATOR_HOST','') == '' and
                    not any(k in values for k in ('NODE_OPTIONS','NODE_PATH','LD_PRELOAD','MIGRATION_DATABASE_URL')) and
                    values.get('RUN_MIGRATIONS','false') == 'false')
            require(service != 'cron' or values.get('CRON_BOOTSTRAP_ONLY') == 'true')
            url = urlsplit(values['DATABASE_URL'])
            require(url.scheme in ('postgres','postgresql') and url.hostname == 'postgres' and
                    url.port in (None,5432) and unquote(url.path) == '/' + self.dbname and
                    unquote(url.username or '') == 'portal_' + service and url.password and
                    not url.query and not url.fragment, 'recovery_runtime_database_mismatch')
            result[service] = (values,unquote(url.password))
        return result

    def authenticate_previous_passwords(self):
        # TCP and a verified host SCRAM rule, never a Unix-socket/trust result or
        # comparison of salted verifier bytes. Password travels only over stdin.
        rules = self.sql("SELECT coalesce(json_agg(auth_method ORDER BY rule_number),'[]') FROM pg_hba_file_rules WHERE type LIKE 'host%';")
        require(rules and set(rules) <= {'scram-sha-256','reject'}, 'recovery_password_auth_unqualified')
        authenticated = []
        for service,(_,password) in self.environments().items():
            require('\n' not in password and '\r' not in password and '\0' not in password)
            query = "BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'role',current_user,'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database())); ROLLBACK;"
            raw = self.command(['/usr/bin/docker','exec','-i',self.pg,'sh','-c',
                'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -XqAt -w -v ON_ERROR_STOP=1 -h 127.0.0.1 "$@"',
                'recovery-auth','--username=portal_' + service,'--dbname=' + self.dbname,'--command=' + query],
                data=password.encode() + b'\n')
            require(self.r._strict_json(raw.strip(),'recovery_auth_invalid') == {'database':self.dbname,
                'role':'portal_' + service,'oid':self.binding['portalTarget']['database']['databaseOid']},
                'recovery_password_auth_failed')
            authenticated.append('portal_' + service)
        return {'roles':authenticated,'transport':'tcp-scram-sha-256','hbaMethodsSha256':value_hash(rules)}

    def container_events(self, kind, service):
        result = []
        for event in self.intent.get('recovery',{}).get('events',[]):
            if event['kind'] == kind:
                value = self.signed_read(os.path.join(self.recovery_directory(create=False),event['sha256'] + '.json'))
                require(value_hash(value) == event['sha256'])
                if value.get('service') == service:
                    result.append(value)
        return result

    def application_spec(self, service):
        require(service in ('api','cron'))
        networks = [n['Id'] for n in self.profile['topology']['networks'] if n['Name'] == 'ownerinc-portal-backend']
        if service == 'api':
            networks += [self.profile['readiness']['egressNetworkId']]
        return {'service':service,'name':'ownerinc-b0-' + self.decision_digest()[:24] + '-' + service,
            'image':self.binding['previousImages'][service], 'environmentSha256':self.profile['readiness'][service + 'EnvironmentSha256'],
            'volume':self.binding['portalTarget']['volumes']['portalUploads']['name'],
            'networks':sorted(networks),'profileSha256':sha(self.profile_raw)}

    def verify_application_container(self, container, service):
        spec = self.application_spec(service)
        intents = self.container_events('container-intent',service)
        require(any(i == {'service':service,'effect':'create','spec':spec} for i in intents), 'recovery_unreceipted_container')
        config,host = container['Config'],container['HostConfig']
        require(container['Name'] == '/' + spec['name'] and config['Image'] == spec['image'] and
                config['Entrypoint'] == ['node'] and config['Cmd'] == ['index.js'] and config['WorkingDir'] == '/app' and
                host['ReadonlyRootfs'] is True and host['Privileged'] is False and
                not host.get('PortBindings') and host['RestartPolicy']['Name'] == 'no' and
                host.get('CapDrop') == ['ALL'] and host.get('SecurityOpt') == ['no-new-privileges'] and
                not host.get('Devices') and not host.get('Binds') and not host.get('VolumesFrom'), 'recovery_container_config_changed')
        actual_env = dict(v.split('=',1) for v in config['Env'])
        environment = self.environments()[service][0]
        require(all(actual_env.get(k) == v for k,v in environment.items()))
        require(not any(k in actual_env for k in ('NODE_OPTIONS','NODE_PATH','LD_PRELOAD','MIGRATION_DATABASE_URL')))
        require(len(container['Mounts']) == 1 and container['Mounts'][0]['Name'] == spec['volume'] and
                container['Mounts'][0]['Destination'] == '/app/uploads' and container['Mounts'][0]['RW'] is False)
        network_ids = {n['Name']:n['Id'] for n in self.profile['topology']['networks']}
        actual_networks = []
        for name,network in container['NetworkSettings']['Networks'].items():
            identity = network.get('NetworkID')
            if not identity:
                # Docker may allocate the endpoint only on start. A created
                # container still must declare exactly the approved networks.
                require(container['State']['Status'] == 'created' and not container['State']['Running'])
                identity = network_ids.get(name,name)
            actual_networks.append(identity)
        actual_networks.sort()
        require(actual_networks == spec['networks'], 'recovery_container_network_changed')
        receipts = self.container_events('container-receipt',service)
        if receipts:
            require(len(receipts) == 1 and receipts[0] == {'service':service,'id':container['Id'],
                'projectionSha256':value_hash(container_projection(container))}, 'recovery_container_receipt_changed')
        else:
            # Create/receipt gap is recoverable ONLY for this deterministic,
            # decision-labelled recovery container and its prior signed intent.
            require(not container['State']['Running'], 'recovery_unreceipted_container')
        if container['State']['Running']:
            require({'service':service,'effect':'start','id':container['Id']} in intents)
        return container['Id']

    def application_containers(self):
        ids = self.command(['/usr/bin/docker','ps','--all','--no-trunc','--filter',
            'label=io.ownerinc.b0-recovery=' + self.decision_digest(),'--format','{{.ID}}']).decode().splitlines()
        require(len(ids) <= 2 and all(HEX.fullmatch(i) for i in ids))
        result = {}
        for c in (self.docker_json('inspect',*ids) if ids else []):
            service = c['Config']['Labels'].get('io.ownerinc.b0-service')
            require(service in ('api','cron') and service not in result)
            self.verify_application_container(c,service); result[service] = c
        return result

    def start_previous_application(self):
        self.boundary(readiness=True)
        for service in ('api','cron'):
            spec = self.application_spec(service)
            intent = {'service':service,'effect':'create','spec':spec}
            if intent not in self.container_events('container-intent',service):
                self.event('container-intent',intent)
            current = self.application_containers().get(service)
            if current is None:
                require(not self.container_events('container-receipt',service), 'recovery_container_missing')
                args = ['/usr/bin/docker','create','--name',spec['name'],'--label','io.ownerinc.b0-recovery=' + self.decision_digest(),
                    '--label','io.ownerinc.b0-service=' + service,'--restart=no','--read-only','--cap-drop=ALL',
                    '--security-opt=no-new-privileges','--env-file',ENV_FILES[service],
                    '--mount','type=volume,src=' + spec['volume'] + ',dst=/app/uploads,readonly',
                    '--workdir=/app','--entrypoint=node']
                for network in spec['networks']:
                    args += ['--network',network]
                self.boundary(readiness=True)
                self.command(args + [spec['image'],'index.js'])
                current = self.application_containers()[service]
            if not self.container_events('container-receipt',service):
                self.event('container-receipt',{'service':service,'id':current['Id'],
                    'projectionSha256':value_hash(container_projection(current))})
            start = {'service':service,'effect':'start','id':current['Id']}
            if start not in self.container_events('container-intent',service):
                self.event('container-intent',start)
            if not current['State']['Running']:
                require(current['State']['Status'] == 'created', 'recovery_application_exited')
                self.boundary(readiness=True)
                self.command(['/usr/bin/docker','start',current['Id']])
        return self.verify_application()

    def verify_application(self):
        self.boundary(readiness=True)
        containers = self.application_containers()
        require(set(containers) == {'api','cron'})
        for service,container in containers.items():
            require(container['State']['Running'])
            result = self.r._strict_json(self.command(['/usr/bin/docker','exec',container['Id'],'node','-e',DB_PROBE]),
                'recovery_application_database_invalid')
            require(result == {'database':self.dbname,'role':'portal_' + service,
                'oid':self.binding['portalTarget']['database']['databaseOid']})
        result = self.verify_readiness_token(self.l.protected(READ_TOKEN,0o600,16384))
        logs = self.command(['/usr/bin/docker','logs','--tail','20',containers['cron']['Id']])
        require(b'"event":"bootstrap_ready"' in logs and b'"event":"started"' not in logs)
        contract,_ = self.load_contract()
        require(self.database_tuple() == contract['restored'])
        require(self.storage.tree(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint']) == self.baseline()['uploads'])
        self.verify_protection(self.read_evidence(self.intent['recovery']['proofs']['protection']))
        return {'containers':{s:c['Id'] for s,c in containers.items()},'databaseAuthenticated':True,
            'api':result,'cronBootstrapOnly':True,'scheduledWorkerQualified':False,'admissionClosed':True}

    def verify_readiness_token(self, raw):
        token = readiness_token(raw)
        self.boundary(readiness=True)
        containers = self.application_containers()
        require('api' in containers and containers['api']['State']['Running'], 'recovery_api_not_running')
        ready = self.profile['readiness']
        request = {k:ready[k] for k in ('uid','uploadPath','uploadSha256')}; request['token'] = token
        result = self.r._strict_json(self.command(['/usr/bin/docker','exec','-i',containers['api']['Id'],
            'node','-e',API_PROBE],data=canonical(request),timeout=25),'recovery_application_probe_failed')
        require(result == {'ready':True,'authenticatedRead':True,'uploadRead':True})
        self.boundary(readiness=True)
        return result

    def credential_refresh(self, request_raw, token_raw):
        request = self.s.parse_canonical(request_raw,'recovery_credential_request_invalid')
        keys(request,'kind purpose decisionSha256 contractSha256 recoveryBindingSha256 profileSha256 previousTokenSha256 tokenSha256')
        require(request['kind'] == 'production-b0-readiness-credential-v1' and
                request['purpose'] == 'refresh-fixed-readiness-identity', 'recovery_credential_request_invalid')
        for name in set(request) - {'kind','purpose'}:
            hash_value(request[name])
        require(self.intent.get('recovery',{}).get('stage') in ('legacy_start_pending','legacy_ready_held'), 'recovery_credential_stage_invalid')
        self.inspect()
        recovery = self.intent['recovery']
        require(request['decisionSha256'] == self.decision_digest() == sha(self.l.protected(DECISION,0o600,CAP)) and
                request['contractSha256'] == self.load_contract()[1] == recovery['binding']['plan']['contractSha256'] and
                request['recoveryBindingSha256'] == value_hash(recovery['binding']) and
                request['profileSha256'] == sha(self.profile_raw) and request['tokenSha256'] == sha(token_raw) and
                request['previousTokenSha256'] != request['tokenSha256'], 'recovery_credential_lineage_mismatch')
        readiness_token(token_raw)
        value = {'requestSha256':sha(request_raw),'request':request}
        events = {'readiness-credential-intent':[], 'readiness-credential-receipt':[]}
        for event in recovery['events']:
            if event['kind'] in events:
                item = self.signed_read(os.path.join(self.recovery_directory(create=False),event['sha256'] + '.json'))
                require(value_hash(item) == event['sha256'])
                events[event['kind']].append(item)
        intents, receipts = events.values()
        # A candidate may itself expire before a crashed publication completes.
        # Retain that intent; a separately authenticated refresh from the exact
        # CURRENT credential can supersede it. Hash compare serializes publication,
        # not the lifetime of a bearer token. No stale intent renews authority.
        require(all(receipt in intents for receipt in receipts) and
                (len(intents) < 32 or value in intents), 'recovery_credential_refresh_exhausted')
        current = self.l.protected(READ_TOKEN,0o600,16384)
        require(sha(current) in (request['previousTokenSha256'],request['tokenSha256']), 'recovery_credential_changed')
        require(sha(current) != request['tokenSha256'] or value in intents, 'recovery_credential_unreceipted')
        require(value not in receipts or sha(current) == request['tokenSha256'], 'recovery_credential_replay')
        self.verify_readiness_token(token_raw)
        require(self.l.protected(READ_TOKEN,0o600,16384) == current, 'recovery_credential_changed')
        return value, current, value in intents, value in receipts

    def signed_write(self, path, body):
        raw = self.s.canonical(self.s.sign_envelope(body, self.key)) + b'\n'
        if os.path.exists(path):
            require(self.l.host_read(path,(0,0),(0o600,),64 * CAP) == raw)
        else:
            self.s._write_exclusive(path, raw, 0o600); self.storage.sync(os.path.dirname(path))
        return sha(raw)

    def signed_read(self, path, expected=None):
        raw = self.l.host_read(path,(0,0),(0o600,),64 * CAP)
        require(expected is None or sha(raw) == expected, 'recovery_evidence_changed')
        return self.s.verify_envelope(self.s.parse_canonical(raw,'recovery_evidence_invalid'), self.key,
            lambda value: value, 'recovery_evidence_invalid')

    def baseline(self):
        return self.signed_read(self.baseline_path, self.intent['b0RecoveryBaseline']['proofSha256'])

    def proposed_contract(self):
        baseline = self.baseline()
        acceptance = self.intent['b0Acceptance']['decision']
        raw = self.l.protected(QUALIFICATION,0o600,CAP)
        require(sha(raw) == acceptance['qualificationEvidenceSha256'])
        measurements = self.s.parse_canonical(raw,'recovery_qualification_invalid')['productionRecovery']
        validate_clone_measurements(measurements,baseline)
        restored = dict(baseline['database'],databaseAclSha256=measurements['databaseAclSha256'])
        return {'kind':'production-exact-b0-recovery-contract-v1','installBindingSha256':value_hash(self.binding),
            'baselineProofSha256':self.intent['b0RecoveryBaseline']['proofSha256'],'profileSha256':sha(self.profile_raw),
            'archiveManifestSha256':baseline['manifestSha256'],'source':baseline['database'],'restored':restored,
            'sourceLayoutSha256':baseline['database']['layoutSha256'],
            'cloneEvidenceSha256':acceptance['qualificationEvidenceSha256'],'procedureRevision':acceptance['procedureRevision']}

    @contextmanager
    def artifacts(self):
        with self.r.open_verified_production_b0(self.binding, self.inventory, self.key) as evidence:
            self._b0_reaffirm = evidence['reaffirm']
            try:
                yield evidence
            finally:
                self._b0_reaffirm = None

    def capture_baseline(self):
        require(self.intent['stage'] == 'reserved' and 'b0Acceptance' not in self.intent and 'recovery' not in self.intent)
        fence = self.boundary()
        if 'b0RecoveryBaseline' in self.intent:
            baseline = self.baseline()
            require(self.database_tuple() == baseline['database'] and
                    self.storage.tree(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint']) == baseline['uploads'])
            with self.artifacts():
                return {'kind':'production-b0-recovery-baseline-result-v1',
                    'baselineProofSha256':self.intent['b0RecoveryBaseline']['proofSha256'],'originStateSha256':self.head}
        with self.artifacts() as artifacts:
            observed = self.database_tuple()
            security = self.security()
            check = self.r.check_portal_legacy_security_baseline(security,self.body,self.material[0],self.material[5],
                self.inventory,self.binding['authority'],self.profile['legacySecurity'])
            # Preserve the legacy check's integration blockers in the evidence;
            # they confer no authority. Every actual unsafe/profile blocker denies.
            require(check['profileMatches'] and set(check['blockers']) == {
                'legacy_security_host_collection_not_integrated','legacy_security_pg16_qualification_required',
                'legacy_role_exclusivity_unverified','legacy_credentials_unverified','legacy_recovery_executor_not_integrated'},
                'recovery_legacy_security_unqualified')
            uploads = self.storage.tree(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint'])
            require(uploads == self.storage.archive_manifest(artifacts['streams']['uploads.tar.gz']), 'recovery_archive_metadata_mismatch')
            require(observed['dataSha256'] == artifacts['proof']['dataFingerprints']['portalDatabase'])
            credentials = self.authenticate_previous_passwords()
            # Schema correspondence is the qualified archive's actual SQL export,
            # not a field asserted PASS. Restore output is compared later to clone.
            artifacts['streams']['postgres.dump'].seek(0)
            archive_schema = self.command(['/usr/bin/docker','exec','-i',self.pg,'pg_restore','--schema-only','--file=-'],
                source=artifacts['streams']['postgres.dump'], timeout=60)
            require(sha(normalize_dump(archive_schema)) == observed['catalogSha256'], 'recovery_archive_schema_mismatch')
            final_fence = self.boundary()
            require(fence['resources'] == final_fence['resources'] and fence['cms'] == final_fence['cms'])
            body = {'kind':'production-b0-recovery-baseline-v1','installBindingSha256':value_hash(self.binding),
                'originStateSha256':self.head,'manifestSha256':sha(artifacts['manifest']),
                'profileSha256':sha(self.profile_raw),'database':observed,'uploads':uploads,
                'archiveSchemaSha256':sha(normalize_dump(archive_schema)), 'securityObservation':security,'legacyCheck':check,
                'credentialAuthentication':credentials,'captureFence':final_fence}
            if not os.path.exists(self.base):
                os.mkdir(self.base,0o700); self.storage.sync(self.root)
            if os.path.exists(self.baseline_path):
                existing = self.signed_read(self.baseline_path)
                require({k:v for k,v in existing.items() if k != 'captureFence'} ==
                        {k:v for k,v in body.items() if k != 'captureFence'} and
                        all(existing['captureFence'][k] == final_fence[k] for k in ('resources','cms')),
                        'recovery_partial_baseline_requires_review')
                body = existing  # Preserve the sealed first witness; do not rewrite it.
            digest = self.signed_write(self.baseline_path,body)
            self.s.bind_recovery_baseline(self.root,self.binding,{'proofSha256':digest,
                'originStateSha256':self.head,'manifestSha256':body['manifestSha256']})
        self.reload()
        return {'kind':'production-b0-recovery-baseline-result-v1','baselineProofSha256':digest,'originStateSha256':self.head}

    def load_contract(self, raw=None):
        baseline = self.baseline()
        if raw is None:
            raw = self.l.protected(CONTRACT,0o600,CAP) if os.path.lexists(CONTRACT) else canonical(self.proposed_contract()) + b'\n'
        contract = validate_contract(self.s.parse_canonical(raw,'recovery_contract_invalid'),self.intent,baseline,sha(self.profile_raw))
        evidence_raw = self.l.protected(QUALIFICATION,0o600,CAP)
        require(sha(evidence_raw) == contract['cloneEvidenceSha256'] and
                sha(self.l.protected(PROCEDURE,0o600,CAP)) == contract['procedureRevision'])
        evidence = self.s.parse_canonical(evidence_raw,'recovery_qualification_invalid')
        validate_clone_measurements(evidence['productionRecovery'],baseline,contract['restored'])
        return contract, sha(raw)

    def inspect(self, contract_raw=None):
        self.authenticate()
        contract,digest = self.load_contract(contract_raw)
        require('b0Acceptance' in self.intent)
        acceptance = self.intent['b0Acceptance']['decision']
        require(contract['cloneEvidenceSha256'] == acceptance['qualificationEvidenceSha256'] and
                contract['procedureRevision'] == acceptance['procedureRevision'])
        with self.artifacts():
            recovery = self.intent.get('recovery')
            if recovery:
                plan = recovery['binding']['plan']; require(plan['contractSha256'] == digest)
                self.boundary(readiness=recovery['stage'] in ('legacy_start_pending','legacy_ready_held'),
                    allow_cms=recovery['stage'] in ('reserved','quiesce_pending'))
            else:
                self.boundary(allow_cms=self.intent['stage'] in ('private_started','private_ready'))
                plan = make_plan(self.body,self.head,digest)
            self.s.validate_production_recovery_plan(plan,self.intent)
        return plan

    def event(self, kind, value):
        digest = value_hash(value)
        directory = self.recovery_directory()
        self.signed_write(os.path.join(directory,digest + '.json'),value)
        self.s.advance_production_recovery(self.root,self.binding,self.intent['recovery']['stage'],
            event={'kind':kind,'sha256':digest})
        self.reload(); return digest

    def recovery_directory(self, create=True):
        path = os.path.join(self.inventory['paths']['preRestoreBackupRoot'],self.decision_digest())
        self.r.INVENTORY._verify_ancestry(os.path.join(os.path.dirname(path),'capture'),{0},'unsafe_inventory_ancestry')
        if not os.path.exists(path):
            require(create, 'recovery_evidence_missing')
            os.mkdir(path,0o700); self.storage.sync(os.path.dirname(path))
        self.s._safe_state_directory(path)
        return path

    def evidence(self, kind, value):
        body = {'kind':kind,'decisionSha256':self.decision_digest(),'value':value}
        digest = value_hash(body)
        self.signed_write(os.path.join(self.recovery_directory(),digest + '.json'),body)
        return digest

    def read_evidence(self, digest):
        body = self.signed_read(os.path.join(self.recovery_directory(create=False),digest + '.json'))
        require(value_hash(body) == digest and body.get('decisionSha256') == self.decision_digest())
        return body['value']

    def protection(self):
        self.boundary()
        directory = self.recovery_directory()
        attempt = sum(e['kind'] == 'capture-attempt' for e in self.intent['recovery']['events'])
        require(attempt < 16,'recovery_capture_attempts_exhausted')
        target = os.path.join(directory,'attempt-%02d' % attempt)
        self.event('capture-attempt',{'attempt':attempt,'originStateSha256':self.head})
        os.mkdir(target,0o700); self.storage.sync(directory)
        before = self.database_tuple()
        previous_uploads = self.storage.tree(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint'])
        cms = self.cms_observation()
        records = []
        def capture(name, producer):
            path = os.path.join(target,name)
            with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as output:
                producer(output); output.flush(); os.fsync(output.fileno())
            self.storage.sync(target)
            records.append({'name':name,**self.r._file_hash(path)})
        capture('postgres.dump',lambda out:self.dump(output=out))
        def upload_capture(volume,out):
            self.command(['/usr/bin/tar','--format=pax','-czf','-','-C',volume,'.'],output=out,limit=32*1024**3,timeout=600)
        capture('uploads.tar.gz',lambda out:upload_capture(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint'],out))
        if cms is not None:
            capture('cms.dump',lambda out:self.dump('ownerinc_cms',output=out))
            capture('cms-uploads.tar.gz',lambda out:upload_capture(self.intent['cmsTarget']['volumes']['cmsUploads']['mountpoint'],out))
        for record in records:
            with open(os.path.join(target,record['name']),'rb') as stream:
                if record['name'].endswith('.dump'):
                    # Consume every compressed data block, not merely the TOC.
                    self.command(['/usr/bin/docker','exec','-i',self.pg,'pg_restore','--file=/dev/null'],
                        source=stream,timeout=600)
                else:
                    self.r._bounded_gzip_tar_tree(stream,self.r.PRODUCTION_B0_TAR_LIMITS)
                    expected = previous_uploads if record['name'] == 'uploads.tar.gz' else self.storage.tree(
                        self.intent['cmsTarget']['volumes']['cmsUploads']['mountpoint'])
                    require(self.storage.archive_manifest(stream) == expected, 'recovery_protection_metadata_mismatch')
        require(self.database_tuple() == before and
                self.storage.tree(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint']) == previous_uploads and
                self.cms_observation() == cms,'recovery_protection_changed')
        self.boundary()
        value = {'attempt':attempt,'artifacts':records,'previousDatabase':before,'previousUploads':previous_uploads,
            'cms':cms,'creation':self.intent['creation'],'b1':self.intent.get('b1'),
            'b1Status':'committed' if 'b1' in self.intent else 'not-committed-partial-material-retained'}
        self.signed_write(os.path.join(target,'sealed.json'),value)
        return value

    def verify_protection(self, value):
        target = os.path.join(self.recovery_directory(create=False),'attempt-%02d' % value['attempt'])
        require(self.signed_read(os.path.join(target,'sealed.json')) == value)
        require(set(os.listdir(target)) == {'sealed.json'} | {a['name'] for a in value['artifacts']})
        for artifact in value['artifacts']:
            path = os.path.join(target,artifact['name']); self.r._safe_regular(path,mode=0o600,owner_root=True)
            require(self.r._file_hash(path) == {k:artifact[k] for k in ('sha256','size')})
        require(self.cms_observation() == value['cms'],'recovery_cms_evidence_changed')

    def restore_database(self, stream, previous, expected):
        self.boundary(); self.quiet()  # Includes any prior restore backend, not just local child PID.
        self.supported_layout()
        actual = self.database_tuple()
        if classify_database(actual,expected,previous) == 'restored':
            return
        require(actual['layoutSha256'] == expected['layoutSha256'],'recovery_layout_unsupported')
        require(actual['rolesSha256'] == expected['rolesSha256'] and actual['databaseAclSha256'] == expected['databaseAclSha256'],
                'recovery_security_requires_unapproved_mutation')
        self.authenticate_previous_passwords(); self.boundary(); stream.seek(0)
        self.command(['/usr/bin/docker','exec','-i','-e','PGAPPNAME=ownerinc-b0-recovery',self.pg,
            'pg_restore','--single-transaction','--clean','--if-exists','--exit-on-error',
            '--username=portal_admin','--dbname=' + self.dbname], source=stream,timeout=600)
        self.boundary(); self.quiet(); require(self.database_tuple() == expected,'recovery_restored_tuple_mismatch')

    def execute(self, decision_raw):
        require(os.path.lexists(CONTRACT), 'recovery_contract_not_provisioned')
        plan = self.inspect()
        decision = self.s.parse_canonical(decision_raw,'recovery_approval_invalid')
        self.s.validate_production_recovery_decision(decision,plan)
        self.s.begin_production_recovery(self.root,self.binding,plan,decision,sha(decision_raw)); self.reload()
        def advance(stage,proof=None):
            self.s.advance_production_recovery(self.root,self.binding,stage,proof); self.reload()
        def stage(): return self.intent['recovery']['stage']
        contract,_ = self.load_contract()
        with self.artifacts() as artifacts:
            if stage() == 'reserved': advance('quiesce_pending')
            if stage() == 'quiesce_pending':
                observation = self.boundary(allow_cms=True)
                for item in observation['resources']:
                    if item['service'] == 'cms' and item['running']:
                        self.command(['/usr/bin/docker','stop','--time','120',item['id']],timeout=150)
                proof = self.evidence('quiescence',self.boundary())
                advance('quiesced',('quiescence',proof))
            if stage() == 'quiesced': advance('protection_capture_pending')
            if stage() == 'protection_capture_pending':
                proof = self.evidence('protection',self.protection())
                advance('protection_verified',('protection',proof))
            protection = self.read_evidence(self.intent['recovery']['proofs']['protection'])
            if stage() == 'protection_verified':
                self.verify_protection(protection); self.boundary()
                require(self.database_tuple() == protection['previousDatabase'])
                advance('database_restore_pending')  # State checks approval clock immediately before append.
            if stage() == 'database_restore_pending':
                self.verify_protection(protection)
                self.restore_database(artifacts['streams']['postgres.dump'],protection['previousDatabase'],contract['restored'])
                advance('database_restored',('database',self.evidence('database',self.database_tuple())))
            if stage() == 'database_restored': advance('uploads_restore_pending')
            if stage() == 'uploads_restore_pending':
                self.boundary(); self.verify_protection(protection)
                require(self.database_tuple() == contract['restored'])
                root = self.binding['portalTarget']['volumes']['portalUploads']['mountpoint']
                desired = self.baseline()['uploads']
                require(self.storage.archive_manifest(artifacts['streams']['uploads.tar.gz']) == desired)
                progress = self.storage.Progress(os.path.join(self.recovery_directory(),'uploads-progress'),
                    self.s,self.key,self.decision_digest())
                digest = self.storage.restore(root,artifacts['streams']['uploads.tar.gz'],protection['previousUploads'],desired,
                    progress,os.path.join(os.path.dirname(root),'.b0-' + self.decision_digest()),lambda:self.boundary())
                self.boundary()
                advance('uploads_restored',('uploads',self.evidence('uploads',{'progressSha256':digest,'treeSha256':value_hash(desired)})))
            if stage() == 'uploads_restored':
                self.boundary(); require(self.database_tuple() == contract['restored'])
                advance('data_verified_readiness_pending')
            if stage() == 'data_verified_readiness_pending':
                self.boundary(); self.authenticate_previous_passwords(); advance('legacy_start_pending')
            if stage() == 'legacy_start_pending':
                result = self.start_previous_application()
                advance('legacy_ready_held',('application',self.evidence('application',result)))
            require(stage() == 'legacy_ready_held')
            self.verify_application(); self.boundary(readiness=True)
        return {'kind':'production-b0-recovery-result-v1','status':'legacy_ready_held',
            'receiptId':self.binding['receiptId'],'admissionClosed':True,'workerHeld':True,
            'routeReleased':False,'decisionSha256':self.decision_digest()}
