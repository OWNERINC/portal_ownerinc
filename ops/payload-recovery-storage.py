#!/usr/bin/python3
"""Closed B0 storage materialization; signed progress lives outside the volume.

Only the authenticated production recovery helper calls this module. No CLI,
environment switches, shell extraction or target selection are exposed.
"""
import hashlib
import copy
import json
import os
import stat
import tarfile
from contextlib import contextmanager

MAX_ENTRIES = 50000
MAX_BYTES = 64 * 1024 ** 3


class StorageError(Exception):
    pass


def require(value):
    if not value:
        raise StorageError('recovery_storage_refused')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sync(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def safe_name(name):
    require(isinstance(name, str) and '\\' not in name and '\0' not in name)
    while name.startswith('./'):
        name = name[2:]
    name = name.rstrip('/')
    if name in ('', '.'):
        return '.'
    require(not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')))
    require(len(name.encode()) <= 4096)
    return name


def metadata(info):
    require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
    require(not stat.S_IMODE(info.st_mode) & 0o7000)
    require(0 <= info.st_uid < 2**32-1 and 0 <= info.st_gid < 2**32-1 and info.st_mtime_ns >= 0)
    if stat.S_ISREG(info.st_mode):
        require(info.st_nlink == 1 and info.st_size <= MAX_BYTES)
        if hasattr(info, 'st_blocks'):
            require(info.st_size == 0 or info.st_blocks * 512 >= info.st_size)
    return {'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file',
            'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'mtime': info.st_mtime_ns // 1000000000}


def path_at(root, name):
    require(safe_name(name) == name)
    path = root if name == '.' else os.path.join(root, *name.split('/'))
    parent = root
    require(stat.S_ISDIR(os.lstat(root).st_mode))
    for part in ([] if name == '.' else name.split('/')[:-1]):
        parent = os.path.join(parent, part)
        require(stat.S_ISDIR(os.lstat(parent).st_mode))
    return path


@contextmanager
def parent_fd(root, name):
    """Resolve each directory without following links and pin it through effect."""
    require(safe_name(name) == name)
    fd = os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in ([] if name == '.' else name.split('/')[:-1]):
            child = os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        yield fd, '.' if name == '.' else name.split('/')[-1]
    finally:
        os.close(fd)


def remove_at(root,name,directory):
    with parent_fd(root,name) as (fd,leaf):
        if directory:
            os.rmdir(leaf,dir_fd=fd)
        else:
            os.unlink(leaf,dir_fd=fd)
        os.fsync(fd)


def mkdir_at(root,name):
    with parent_fd(root,name) as (fd,leaf):
        os.mkdir(leaf,0o700,dir_fd=fd);os.fsync(fd)


def replace_at(staging,temporary,root,name):
    with parent_fd(staging,os.path.basename(temporary)) as (source,source_name), parent_fd(root,name) as (target,target_name):
        os.replace(source_name,target_name,src_dir_fd=source,dst_dir_fd=target)
        os.fsync(source);os.fsync(target)


def entry(path):
    before = os.lstat(path)
    value = metadata(before)
    if hasattr(os, 'listxattr'):
        require(not os.listxattr(path, follow_symlinks=False))
    if value['kind'] == 'file':
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            opened = os.fstat(fd)
            require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
            digest = hashlib.sha256()
            while True:
                block = os.read(fd, 1024 * 1024)
                if not block:
                    break
                digest.update(block)
            identity = lambda s: (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
            require(identity(os.fstat(fd)) == identity(opened) and identity(os.lstat(path)) == identity(before))
            value.update(size=before.st_size, sha256=digest.hexdigest())
        finally:
            os.close(fd)
    return value


def tree(root):
    result = {'.': entry(root)}
    require(result['.']['kind'] == 'directory')
    pending = ['.']
    total = 0
    while pending:
        name = pending.pop()
        for child in sorted(os.listdir(path_at(root, name))):
            relative = child if name == '.' else name + '/' + child
            require(safe_name(relative) == relative and len(result) < MAX_ENTRIES)
            result[relative] = value = entry(path_at(root, relative))
            total += value.get('size', 0)
            require(total <= MAX_BYTES)
            if value['kind'] == 'directory':
                pending.append(relative)
    return result


def archive_manifest(stream):
    """Caller also runs runtime's bounded tar parser before this metadata pass."""
    stream.seek(0)
    result = {}
    total = 0
    with tarfile.open(fileobj=stream, mode='r|gz') as archive:
        for member in archive:
            name = safe_name(member.name)
            require(name not in result and len(result) < MAX_ENTRIES and (member.isdir() or member.isfile()))
            require(not member.mode & 0o7000 and 0 <= member.uid < 2**32-1 and 0 <= member.gid < 2**32-1 and
                    member.mtime >= 0 and not member.sparse)
            require(not any('xattr' in k.lower() or 'acl' in k.lower() for k in member.pax_headers))
            value = {'kind': 'directory' if member.isdir() else 'file', 'uid': member.uid,
                     'gid': member.gid, 'mode': member.mode, 'mtime': int(member.mtime)}
            if member.isfile():
                total += member.size
                require(total <= MAX_BYTES)
                digest = hashlib.sha256()
                with archive.extractfile(member) as data:
                    while True:
                        block = data.read(1024 * 1024)
                        if not block:
                            break
                        digest.update(block)
                value.update(size=member.size, sha256=digest.hexdigest())
            result[name] = value
            archive.members.clear()
    require('.' in result and result['.']['kind'] == 'directory')
    for name in result:
        for i in range(1, len(name.split('/'))):
            require(result.get('/'.join(name.split('/')[:i]), {}).get('kind') == 'directory')
    return result


def operations(previous, desired):
    result = []
    conflicts = {name for name in previous if name in desired and previous[name]['kind'] != desired[name]['kind']}
    removed = {name for name in previous if name != '.' and
               (name not in desired or name in conflicts or any(name.startswith(p + '/') for p in conflicts))}
    for name in sorted(removed, key=lambda n: (-n.count('/'), n)):
        result.append({'operation': 'remove', 'name': name, 'before': previous[name], 'after': None})
    for name in sorted(desired, key=lambda n: (n.count('/'), n)):
        if name == '.':
            continue
        before = None if name in removed else previous.get(name)
        if desired[name]['kind'] == 'directory':
            if before is None:
                result.append({'operation': 'mkdir', 'name': name, 'before': None, 'after': desired[name]})
        elif before != desired[name]:
            for effect in ('materialize', 'uid', 'gid', 'mode', 'mtime', 'replace'):
                result.append({'operation': effect, 'name': name, 'before': before, 'after': desired[name]})
    for name in sorted((n for n in desired if desired[n]['kind'] == 'directory'), key=lambda n: (-n.count('/'), n == '.', n)):
        for effect in ('uid', 'gid', 'mode', 'mtime'):
            result.append({'operation': effect, 'name': name, 'before': previous.get(name), 'after': desired[name]})
    # Root is always last, after all directory timestamp-changing operations.
    result.sort(key=lambda op: op['name'] == '.')
    return result


class Progress:
    """Exclusive signed intent/completion chain; never silently repairs corruption."""
    def __init__(self, directory, state, key, binding):
        self.directory, self.state, self.key, self.binding = directory, state, key, binding
        if not os.path.exists(directory):
            os.mkdir(directory, 0o700); sync(os.path.dirname(directory))
        state._safe_state_directory(directory)
        self.records, previous = [], None
        for index, name in enumerate(sorted(os.listdir(directory))):
            require(name == '%08d.json' % index and index < MAX_ENTRIES * 16)
            raw = state._read_file(os.path.join(directory, name), 0o600, private_owner=True)
            envelope = state.parse_canonical(raw, 'recovery_progress_invalid')
            body = state.verify_envelope(envelope, key, lambda x: x, 'recovery_progress_invalid')
            require(set(body) == {'sequence', 'previous', 'binding', 'record'} and body['sequence'] == index and
                    body['previous'] == previous and body['binding'] == binding)
            self.records.append(body['record']); previous = hashlib.sha256(raw).hexdigest()
        self.previous = previous

    def append(self, record):
        require(len(self.records) < MAX_ENTRIES * 16)
        body = {'sequence': len(self.records), 'previous': self.previous, 'binding': self.binding, 'record': record}
        raw = self.state.canonical(self.state.sign_envelope(body, self.key)) + b'\n'
        self.state._write_exclusive(os.path.join(self.directory, '%08d.json' % len(self.records)), raw, 0o600)
        sync(self.directory)
        self.previous = hashlib.sha256(raw).hexdigest(); self.records.append(record)


def metadata_effect(path, field, value, directory_fd=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW,dir_fd=directory_fd)
    try:
        if field == 'uid':
            os.fchown(fd, value, -1)
        elif field == 'gid':
            os.fchown(fd, -1, value)
        elif field == 'mode':
            os.fchmod(fd, value)
        else:
            require(field == 'mtime')
            os.utime(fd, ns=(value * 1000000000,) * 2)
        os.fsync(fd)
    finally:
        os.close(fd)


def materialize(stream, name, path, desired):
    """Resume only an exact archive prefix. No truncation and no leaked reader."""
    stream.seek(0)
    with tarfile.open(fileobj=stream, mode='r|gz') as archive:
        for member in archive:
            if safe_name(member.name) != name:
                archive.members.clear()
                continue
            require(member.isfile())
            flags = os.O_RDWR | os.O_NOFOLLOW
            if not os.path.lexists(path):
                flags |= os.O_CREAT | os.O_EXCL
            fd = os.open(path, flags, 0o600)
            with os.fdopen(fd, 'r+b') as output, archive.extractfile(member) as data:
                info = os.fstat(output.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= member.size and
                        info.st_uid == os.geteuid() and info.st_gid == os.getegid() and stat.S_IMODE(info.st_mode) == 0o600)
                while True:
                    chunk = output.read(1024 * 1024)
                    if not chunk:
                        break
                    require(data.read(len(chunk)) == chunk)
                while True:
                    chunk = data.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                output.flush(); os.fsync(output.fileno())
            observed = entry(path)
            require(all(observed[k] == desired[k] for k in ('kind', 'size', 'sha256')))
            sync(os.path.dirname(path))
            return
    require(False)


def projected_tree(previous, program, count):
    expected = copy.deepcopy(previous)
    for op in program[:count]:
        name,action,after = op['name'],op['operation'],op['after']
        if action == 'remove':
            expected.pop(name)
        elif action == 'mkdir':
            expected[name] = {'kind':'directory','uid':os.geteuid(),'gid':os.getegid(),'mode':0o700,'mtime':None}
        elif action == 'replace':
            expected[name] = dict(after)
        elif action in ('uid','gid','mode','mtime') and after['kind'] == 'directory':
            expected[name][action] = after[action]
        if action in ('remove','mkdir','replace'):
            parent = name.rpartition('/')[0] or '.'
            expected[parent]['mtime'] = None  # Only a known child-changing effect.
    return expected


def matches_tree(observed, expected):
    return set(observed) == set(expected) and all(set(observed[n]) == set(v) and
        all(value is None and k == 'mtime' or observed[n][k] == value for k,value in v.items())
        for n,v in expected.items())


def restore(root, archive_stream, previous, desired, progress, staging, boundary):
    """Replay a deterministic edit program; no recursive clear or blind extraction."""
    require(os.path.dirname(staging) == os.path.dirname(root) and staging != root)
    program = operations(previous, desired)
    require(len(progress.records) <= 2 * len(program) + 2)
    if not progress.records:
        require(tree(root) == previous)
        progress.append({'kind': 'staging-intent'})
    require(progress.records[0] == {'kind': 'staging-intent'})
    if len(progress.records) == 1:
        boundary()
        if not os.path.exists(staging):
            os.mkdir(staging, 0o700); sync(os.path.dirname(staging))
        require(stat.S_ISDIR(os.lstat(staging).st_mode) and stat.S_IMODE(os.lstat(staging).st_mode) == 0o700)
        require(os.stat(staging).st_dev == os.stat(root).st_dev and not os.listdir(staging))
        progress.append({'kind': 'staging-ready'})
    require(progress.records[1] == {'kind': 'staging-ready'})
    info = os.lstat(staging)
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and
            (info.st_uid,info.st_gid) == (os.geteuid(),os.getegid()) and info.st_dev == os.stat(root).st_dev)
    for index, operation in enumerate(program):
        offset = 2 + index * 2
        intent = {'kind': 'intent', 'index': index, 'operation': operation}
        complete = {'kind': 'complete', 'index': index}
        if len(progress.records) > offset:
            require(progress.records[offset] == intent)
        else:
            boundary(); progress.append(intent)
        if len(progress.records) > offset + 1:
            require(progress.records[offset + 1] == complete)
            continue
        boundary()
        observed_tree = tree(root)
        require(matches_tree(observed_tree,projected_tree(previous,program,index)) or
                matches_tree(observed_tree,projected_tree(previous,program,index+1)))
        allowed_temps = {hashlib.sha256(op['name'].encode()).hexdigest() for op in program[:index+1]
                         if op['operation'] == 'materialize'} - {
                         hashlib.sha256(op['name'].encode()).hexdigest() for op in program[:index]
                         if op['operation'] == 'replace'}
        require(set(os.listdir(staging)) <= allowed_temps)
        path = path_at(root, operation['name'])
        observed = entry(path) if os.path.lexists(path) else None
        before, after, action = operation['before'], operation['after'], operation['operation']
        if action == 'remove':
            if observed is not None:
                # Children have already changed directory mtime, never its owner/mode.
                require(observed == before or observed['kind'] == before['kind'] == 'directory' and
                        all(observed[k] == before[k] for k in ('uid', 'gid', 'mode')))
                remove_at(root,operation['name'],observed['kind'] == 'directory')
        elif action == 'mkdir':
            if observed is None:
                mkdir_at(root,operation['name'])
            else:
                require(observed['kind'] == 'directory' and observed['mode'] == 0o700 and not os.listdir(path))
        elif action in ('uid','gid','mode','mtime'):
            if after['kind'] == 'file':
                path = os.path.join(staging, hashlib.sha256(operation['name'].encode()).hexdigest())
                observed = entry(path)
                require(all(observed[k] == after[k] for k in ('kind','size','sha256')))
            else:
                require(observed is not None and observed['kind'] == 'directory')
            allowed = (before, after, {'uid': os.geteuid(), 'gid': os.getegid(),
                'mode': 0o600 if after['kind'] == 'file' else 0o700})
            for field in ('uid', 'gid', 'mode'):
                require(observed[field] in {v[field] for v in allowed if v is not None})
            anchor = staging if after['kind'] == 'file' else root
            relative = os.path.basename(path) if after['kind'] == 'file' else operation['name']
            with parent_fd(anchor,relative) as (fd,leaf):
                metadata_effect(leaf,action,after[action],fd);os.fsync(fd)
        else:
            require(action in ('materialize','replace') and observed in (before, after))
            temporary = os.path.join(staging, hashlib.sha256(operation['name'].encode()).hexdigest())
            if action == 'materialize':
                require(observed == before)
                materialize(archive_stream, operation['name'], temporary, after)
            elif observed == after:
                require(not os.path.lexists(temporary))  # Rename-before-completion.
            else:
                require(entry(temporary) == after)
                boundary()
                require((entry(path) if os.path.lexists(path) else None) == before)
                replace_at(staging,temporary,root,operation['name'])
                require(entry(path) == after)
        progress.append(complete)
    require(tree(root) == desired and not os.listdir(staging))
    return progress.previous
