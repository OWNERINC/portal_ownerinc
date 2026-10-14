#!/usr/bin/env python3
"""Fixed disposable B0 recovery qualifier. NOT a production recovery dispatcher.

Only --qualify exists: it creates its own resources, key, signed request and B0.
No user-supplied SQL, target, key, request path or recovery fault is a CLI input.
The internal executor consumes authenticated bytes and the real signed journal.
"""
import gzip
import difflib
from collections import Counter
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

PG = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
NGINX = 'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752'
HELPERS = ('payload-control-state.py', 'payload-control-inventory.py', 'payload-control-runtime.py', 'payload-install-recovery-isolated.py')
CAP = 16 * 1024 * 1024
CHILD_LOCATIONS = ('entry_authentication', 'boundary', 'security_compare', 'role_authentication',
                   'schema_compare', 'schema_dump', 'schema_normalization', 'database_dump_compare', 'database_data_compare', 'database_restore',
                   'checkpoint', 'uploads_clear', 'uploads_extract', 'uploads_compare', 'complete', 'unknown')
CHILD_FAILURES = ('none', 'expected_interruption', 'refused', 'unknown', 'expected_interruption_missing',
                  'child_exit', 'checkpoint_mismatch', 'malformed_frame', 'schema_line_order_delta',
                  'schema_comment_delta', 'schema_sql_delta')
DIAGNOSTIC_LOCATION = 'entry_authentication'
REPORT_NAME = 'schema-discrepancy.json'
REPORT_LIMIT = 65536
REPORT_EXPORT_PARENT = '/home/runner/work/_temp'
REPORT_EXPORT_DIRECTORY = 'payload-b0-schema-diagnostic'
SQL_WORDS = frozenset('CREATE ALTER DROP TABLE SCHEMA EXTENSION SEQUENCE INDEX UNIQUE CONSTRAINT CHECK DEFAULT NOT NULL PRIMARY KEY FOREIGN REFERENCES ON OWNER TO COMMENT IS SET SELECT FROM AS WITH USING ONLY ADD TYPE COLLATE INHERITS GENERATED ALWAYS BY IDENTITY START INCREMENT MINVALUE MAXVALUE CACHE NO CYCLE FUNCTION RETURNS LANGUAGE SECURITY DEFINER INVOKER GRANT REVOKE ALL PRIVILEGES PUBLIC CASCADE RESTRICT VALIDATE VALID VALUES TRUE FALSE AND OR IN ANY ARRAY'.split())
SAFE_IDENTIFIERS = frozenset(('public', 'pg_catalog', 'postgres', 'pg_database_owner', 'pgcrypto', 'portal_api', 'portal_cron', 'recovery_records'))
OBJECT_TYPES = ('TABLE', 'SCHEMA', 'EXTENSION', 'SEQUENCE', 'SEQUENCE OWNED BY', 'INDEX', 'CONSTRAINT',
                'FK CONSTRAINT', 'DEFAULT', 'FUNCTION', 'TRIGGER', 'POLICY', 'TYPE', 'DOMAIN', 'COMMENT', 'ACL', 'UNKNOWN')
QUOTED_PREFIX = re.compile(r"(?:[eEbBxXnN]|[uU]&)?(['\"])")
DOLLAR_PREFIX = re.compile(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$')
IDENTIFIER_TOKEN = re.compile(r'[A-Za-z_][A-Za-z_0-9$]*')
NUMBER_TOKEN = re.compile(r'[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?')


def reject_literal_continuation(text, pos):
    """Do not lex continuation fragments with a newly reset escape mode.

    Suppress adjacent quoted strings across whitespace/comments, even same-line
    adjacency or an explicit second prefix. This deliberately over-rejects rather
    than implementing PostgreSQL's newline-dependent string concatenation rules.
    The main lexer still consumes trivia normally when no fragment follows.
    """
    while pos < len(text):
        if text[pos].isspace():
            pos += 1
        elif text.startswith('--', pos):
            pos += 2
            while pos < len(text) and text[pos] not in '\r\n':
                pos += 1
        elif text.startswith('/*', pos):
            pos += 2
            depth = 1
            while depth:
                require(pos < len(text))
                if text.startswith('/*', pos):
                    depth += 1
                    require(depth <= 32)
                    pos += 2
                elif text.startswith('*/', pos):
                    depth -= 1
                    pos += 2
                else:
                    pos += 1
        else:
            following = QUOTED_PREFIX.match(text, pos)
            require(following is None or following[1] != "'")
            return


def redacted_schema(raw):
    """Small fail-closed lexer, NOT a SQL parser. No unrecognized text is emitted."""
    require(isinstance(raw, bytes) and len(raw) <= CAP)
    text = raw.decode('utf-8', errors='strict')
    require('\x00' not in text)
    tokens, pos, line = [], 0, 1
    while pos < len(text):
        start, first = pos, line
        char = text[pos]
        if char.isspace():
            line += char == '\n'
            pos += 1
            continue
        kind, visible = None, None
        if text.startswith('--', pos):
            end = text.find('\n', pos)
            pos = len(text) if end < 0 else end
            kind = 'comment'
        elif text.startswith('/*', pos):
            pos += 2
            depth = 1
            while depth:
                require(pos < len(text))
                if text.startswith('/*', pos):
                    depth += 1
                    require(depth <= 32)
                    pos += 2
                elif text.startswith('*/', pos):
                    depth -= 1
                    pos += 2
                else:
                    pos += 1
            kind = 'comment'
        else:
            prefix = QUOTED_PREFIX.match(text, pos)
            dollar = DOLLAR_PREFIX.match(text, pos)
            if prefix:
                quote = prefix[1]
                escaped = prefix[0].upper().startswith(('E', 'U&'))
                pos = prefix.end()
                while True:
                    require(pos < len(text))
                    if text[pos] == quote:
                        pos += 1
                        if pos < len(text) and text[pos] == quote:
                            pos += 1
                            continue
                        break
                    if text[pos] == '\\' and escaped:
                        pos += 1
                        require(pos < len(text))
                    pos += 1
                kind = 'quoted_identifier' if quote == '"' else 'literal'
                if quote == "'":
                    reject_literal_continuation(text, pos)
            elif dollar:
                delimiter = dollar[0]
                end = text.find(delimiter, pos + len(delimiter))
                require(end >= 0)
                pos = end + len(delimiter)
                kind = 'body'
            elif char.isascii() and (char.isalpha() or char == '_'):
                match = IDENTIFIER_TOKEN.match(text, pos)
                pos = match.end()
                word = match[0]
                if word.upper() in SQL_WORDS:
                    kind, visible = 'keyword', word.upper()
                elif word in SAFE_IDENTIFIERS:
                    kind, visible = 'identifier', word
                else:
                    kind = 'identifier_hash'
            elif char.isascii() and char.isdigit():
                match = NUMBER_TOKEN.match(text, pos)
                pos = match.end()
                kind = 'number'
            elif char in '(),;.:=+-*/<>[]!~|&^%?@#':
                kind, visible = 'punctuation', char
                pos += 1
            else:
                require(False)
        value = text[start:pos].encode('utf-8')
        line += text[start:pos].count('\n')
        token = {'kind': kind, 'lines': [first, line]}
        if visible is not None:
            token['value'] = visible
        else:
            token.update(length=len(value), sha256=digest(value))
        tokens.append(token)
        require(len(tokens) <= 100000)
    return tokens


def schema_discrepancy(before, after):
    # Lex everything BEFORE emitting anything: malformed suffix suppresses report.
    streams = [redacted_schema(value) for value in (before, after)]
    lines = [value.splitlines(keepends=True) for value in (before, after)]
    require(all(len(value) <= 10000 for value in lines))
    changes = [op for op in difflib.SequenceMatcher(None, lines[0], lines[1], autojunk=True).get_opcodes() if op[0] != 'equal']
    def side(index, start, end):
        lo, hi = max(0, start - 2), min(len(lines[index]), end + 2)
        object_type, identity = 'UNKNOWN', digest(b'')
        # Header content is never emitted, and is used only for diagnostics.
        for item in reversed(lines[index][:start + 1]):
            header = re.fullmatch(rb'-- Name: (.*); Type: ([A-Z ]+); Schema: (.*); Owner: (.*)\r?\n?', item)
            if header:
                candidate = header[2].decode('ascii')
                object_type = candidate if candidate in OBJECT_TYPES else 'UNKNOWN'
                identity = digest(item)
                break
        return {'range': [start + 1, end], 'contextRange': [lo + 1, hi], 'objectType': object_type,
                'objectIdentitySha256': identity, 'sha256': digest(b''.join(lines[index][start:end])),
                'tokens': [token for token in streams[index] if token['lines'][0] <= hi and token['lines'][1] >= lo + 1]}
    result = {'version': 1, 'kind': 'nonqualifying-isolated-b0-schema-discrepancy',
              'before': {'length': len(before), 'sha256': digest(before)},
              'after': {'length': len(after), 'sha256': digest(after)},
              'regionCount': len(changes), 'truncated': False, 'regions': []}
    for _, a, b, c, d in changes:
        region = {'before': side(0, a, b), 'after': side(1, c, d)}
        result['regions'].append(region)
        if len(canonical(result)) > REPORT_LIMIT:
            result['regions'].pop()
            result['truncated'] = True
            break
    return canonical(result)


def capture_schema_discrepancy(directory, before, after):
    # First mismatch only; private exclusive write, no raw schemas persisted.
    raw = schema_discrepancy(before, after)
    validate_schema_report(raw)
    fd = os.open(directory / REPORT_NAME, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def export_schema_discrepancy(directory):
    """Fixed hosted-runner destination, never a CLI/environment-selected target."""
    source = directory / REPORT_NAME
    if not source.exists():
        return
    raw = private_bytes(source, REPORT_LIMIT)
    # Only our private first-mismatch producer creates this file. Re-encode to
    # require canonical bytes and reject duplicate-key/noncanonical substitutions.
    validate_schema_report(raw)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    runner_uid = None
    try:
        for component in REPORT_EXPORT_PARENT.strip('/').split('/'):
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if component == 'runner':
                runner_uid = info.st_uid
            require(info.st_uid in (0, runner_uid) and not stat.S_IMODE(info.st_mode) & 0o022)
        os.mkdir(REPORT_EXPORT_DIRECTORY, 0o700, dir_fd=fd)
        child = os.open(REPORT_EXPORT_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
        require(os.fstat(fd).st_uid == 0 and stat.S_IMODE(os.fstat(fd).st_mode) == 0o700)
        output = os.open(REPORT_NAME, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(output, 'wb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        os.fchmod(fd, 0o755)
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_schema_report(raw):
    require(isinstance(raw, bytes) and len(raw) <= REPORT_LIMIT)
    value = json.loads(raw)
    require(canonical(value) == raw)
    def keys(obj, names):
        require(isinstance(obj, dict) and set(obj) == set(names.split()))
    def integer(number, maximum=CAP):
        require(type(number) is int and 0 <= number <= maximum)
    def hash_value(text):
        require(isinstance(text, str) and re.fullmatch('[a-f0-9]{64}', text) is not None)
    def lines(pair):
        require(isinstance(pair, list) and len(pair) == 2)
        for number in pair:
            integer(number, 10001)
    keys(value, 'version kind before after regionCount truncated regions')
    require(type(value['version']) is int and value['version'] == 1 and value['kind'] == 'nonqualifying-isolated-b0-schema-discrepancy')
    require(type(value['truncated']) is bool and isinstance(value['regions'], list))
    integer(value['regionCount'], 20000)
    require(len(value['regions']) <= value['regionCount'])
    require(value['truncated'] == (len(value['regions']) < value['regionCount']))
    for name in ('before', 'after'):
        keys(value[name], 'length sha256')
        integer(value[name]['length'])
        hash_value(value[name]['sha256'])
    for region in value['regions']:
        keys(region, 'before after')
        for side in region.values():
            keys(side, 'range contextRange objectType objectIdentitySha256 sha256 tokens')
            lines(side['range']); lines(side['contextRange'])
            require(side['objectType'] in OBJECT_TYPES)
            hash_value(side['objectIdentitySha256']); hash_value(side['sha256'])
            require(isinstance(side['tokens'], list))
            for token in side['tokens']:
                require(isinstance(token, dict))
                kind = token.get('kind')
                if kind in ('keyword', 'identifier', 'punctuation'):
                    keys(token, 'kind lines value')
                    allowed = SQL_WORDS if kind == 'keyword' else SAFE_IDENTIFIERS if kind == 'identifier' else tuple('(),;.:=+-*/<>[]!~|&^%?@#')
                    require(isinstance(token['value'], str) and token['value'] in allowed)
                else:
                    keys(token, 'kind lines length sha256')
                    require(kind in ('comment', 'quoted_identifier', 'literal', 'body', 'identifier_hash', 'number'))
                    integer(token['length']); hash_value(token['sha256'])
                lines(token['lines'])
    return value


def mark(location):
    global DIAGNOSTIC_LOCATION
    DIAGNOSTIC_LOCATION = location if location in CHILD_LOCATIONS else 'unknown'


def child_frame(failure, proof=None):
    return canonical({'version': 1, 'location': DIAGNOSTIC_LOCATION if DIAGNOSTIC_LOCATION in CHILD_LOCATIONS else 'unknown',
                      'failure': failure if failure in CHILD_FAILURES else 'unknown', 'proof': proof})


def parse_child_frame(raw, exit_code, fault):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    require(isinstance(raw, bytes) and len(raw) <= 1024)
    value = json.loads(raw, object_pairs_hook=pairs)
    require(isinstance(value, dict) and set(value) == {'version', 'location', 'failure', 'proof'})
    require(type(value['version']) is int and value['version'] == 1 and value['location'] in CHILD_LOCATIONS and value['failure'] in CHILD_FAILURES)
    if exit_code == 72:
        require(fault in ('database', 'uploads') and value['failure'] == 'expected_interruption' and value['proof'] is None)
        require(value['location'] == ('database_restore' if fault == 'database' else 'uploads_extract'))
    elif exit_code == 0:
        require(fault is None and value['failure'] == 'none' and value['location'] == 'complete')
        require(canonical(value['proof']) == canonical({'kind': 'isolated-b0-recovery-proof', 'dataVerified': True, 'admissionClosed': True,
                                  'readinessPending': True, 'productionAuthorized': False, 'applicationRollbackExecuted': False}))
    else:
        require(exit_code == 73 and value['proof'] is None and value['failure'] in ('refused', 'unknown', 'expected_interruption_missing',
                    'schema_line_order_delta', 'schema_comment_delta', 'schema_sql_delta'))
        if value['failure'].startswith('schema_'):
            require(value['location'] == 'schema_compare')
    return value


def check_child_checkpoint(body, fault):
    expected = {'database': 'database_restore_pending', 'uploads': 'uploads_restore_pending', None: 'data_verified_readiness_pending'}[fault]
    require(body['installIntent']['recovery']['stage'] == expected)


def write_child_frame(descriptor, failure, proof=None):
    # Diagnostic transport must not replace the original exit classification.
    try:
        raw = child_frame(failure, proof)
        if len(raw) <= 1024:
            os.write(descriptor, raw)
    except Exception:
        pass


class Refused(Exception):
    pass


class SchemaMismatch(Refused):
    pass


def failure_for_exception(error, fault):
    if type(error) is SchemaMismatch and error.args in (('schema_line_order_delta',), ('schema_comment_delta',), ('schema_sql_delta',)):
        return error.args[0], 73
    if isinstance(error, Refused):
        if error.args == ('isolated_b0_test_interruption',) and fault in ('database', 'uploads'):
            return 'expected_interruption', 72
        return 'refused', 73
    return 'unknown', 73


def require(value):
    if not value:
        raise Refused('isolated_b0_recovery_refused')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def private_bytes(path, maximum=CAP):
    def identity(value):
        return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
                value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum)
    if os.name != 'nt':
        require(before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) == 0o600)
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        require(identity(os.fstat(stream.fileno())) == identity(before))
        raw = stream.read(maximum + 1)
        require(len(raw) <= maximum and identity(os.fstat(stream.fileno())) == identity(before) and identity(os.lstat(path)) == identity(before))
    return raw  # Immutable private copy; these exact bytes are consumed, never reopened.


def authenticate(raw, key):
    require(isinstance(raw, bytes) and len(raw) <= 65536 and isinstance(key, bytes) and len(key) == 32)
    def unique(pairs):
        result = {}
        for name, value in pairs:
            require(name not in result)
            result[name] = value
        return result
    envelope = json.loads(raw, object_pairs_hook=unique)
    require(set(envelope) == {'body', 'signature'})
    signature = envelope['signature']
    require(set(signature) == {'algorithm', 'keyId', 'value'} and signature['algorithm'] == 'HMAC-SHA256')
    require(signature['keyId'] == digest(key)[:24] and hmac.compare_digest(signature['value'], hmac.new(key, canonical({'body': envelope['body']}), hashlib.sha256).hexdigest()))
    return envelope['body']


def load_helpers(directory, approved):
    require(set(approved) == set(HELPERS))
    for name in HELPERS:
        require(digest(private_bytes(directory / name)) == approved[name])
    # All imports are from the supervisor's private copied closure, verified first.
    spec = importlib.util.spec_from_file_location('isolated_recovery_runtime', directory / 'payload-control-runtime.py')
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    return runtime


def normalize_dump(raw):
    # pg_dump's paired randomized framing, not arbitrary SQL/content normalization.
    lines = raw.splitlines(keepends=True)
    starts = [line for line in lines if line.startswith(b'\\restrict ')]
    ends = [line for line in lines if line.startswith(b'\\unrestrict ')]
    require(len(starts) == len(ends) and len(starts) <= 1)
    if starts:
        require(starts[0].split()[1] == ends[0].split()[1])
    return b''.join(line for line in lines if line not in starts + ends)


def schema_delta(expected, observed):
    """Diagnostic ONLY, never equality/authorization or SQL normalization.

    Inputs are the exact normalized dump bytes whose hashes failed comparison.
    A comment-looking line can be function-body content: this classification
    deliberately makes NO assertion of SQL semantic equivalence.
    """
    require(isinstance(expected, bytes) and isinstance(observed, bytes) and len(expected) <= CAP and len(observed) <= CAP)
    before, after = expected.splitlines(keepends=True), observed.splitlines(keepends=True)
    if Counter(before) == Counter(after):
        return 'schema_line_order_delta'
    def non_comment(lines):
        return [line for line in lines if not line.startswith(b'--') and line.strip()]
    if non_comment(before) == non_comment(after):
        return 'schema_comment_delta'
    return 'schema_sql_delta'


def assert_schema_dump(expected, observed, approved_digest, diagnostic=None):
    mark('schema_compare')
    # The retained baseline is diagnostic material, not a replacement authority.
    require(digest(expected) == approved_digest)
    if digest(observed) != approved_digest:
        if diagnostic is not None:
            try:
                diagnostic(expected, observed)
            except Exception:
                pass  # Diagnostic suppression must never replace the mismatch.
        try:
            category = schema_delta(expected, observed)
        except Exception:
            category = 'schema_sql_delta'
        raise SchemaMismatch(category)


def uploads_fingerprint(raw):
    require(len(raw) <= CAP)
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
        expanded = compressed.read(CAP + 1)
    require(len(expanded) <= CAP)
    result = {}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for member in archive:
            require(member.uid == 0 and member.gid == 0 and not member.mode & 0o7000)
            name = member.name.removeprefix('./')
            if member.isdir() and name in ('', '.'):
                continue
            require(member.isfile() and name in ('original.txt', 'nested.txt') and name not in result and member.size <= 4096)
            result[name] = {'sha256': digest(archive.extractfile(member).read(4097)), 'mode': member.mode, 'uid': member.uid, 'gid': member.gid, 'size': member.size}
    require(set(result) == {'original.txt', 'nested.txt'})
    return digest(canonical(result))


class Executor:
    """Internal TEST capability. Supervisor is sole caller; no production entry."""
    def __init__(self, directory, runtime, key, request_raw, operations, lease):
        self.directory, self.runtime, self.key = directory, runtime, key
        self.state = runtime.STATE
        self.request = authenticate(request_raw, key)
        require(set(self.request) == {'kind', 'binding', 'recovery', 'helpers', 'artifacts', 'baseline', 'fenceProfile'})
        require(self.request['kind'] == 'isolated-b0-recovery-request-v1')
        self.binding = self.request['binding']
        # No subprocess or filesystem mutation precedes this production refusal.
        require(self.binding.get('bindingVersion') == 2 and self.binding['candidate']['purpose'] == 'isolated-recovery-producer')
        self.state.validate_install_binding(self.binding)
        require(self.binding['b0']['directory'] == str(directory / 'b0'))
        require(set(self.request['helpers']) == set(HELPERS))
        require(set(self.request['baseline']) == {'database', 'uploads', 'schema', 'roles', 'dataFingerprint', 'uploadsFingerprint'})
        require(all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in self.request['baseline'].values()))
        require(digest(canonical(self.request['fenceProfile'])) == self.request['recovery']['fenceProfileSha256'])
        self.operations, self.lease = operations, lease
        self.artifacts = {}
        require(set(self.request['artifacts']) == {'postgres.dump', 'uploads.tar.gz', 'manifest.sha256', 'preauthority-proof.json'})
        require(set(os.listdir(directory / 'b0')) == set(self.request['artifacts']))
        for name, expected in self.request['artifacts'].items():
            raw = private_bytes(directory / 'b0' / name)
            require(digest(raw) == expected)
            self.artifacts[name] = raw
        proof = self.state.verify_envelope(json.loads(self.artifacts['preauthority-proof.json']), key, self.state.validate_proof_body, 'invalid_proof')
        require(digest(canonical(json.loads(self.artifacts['preauthority-proof.json']))) == self.binding['b0']['proofSha256'])
        require(proof['source']['portal'] == self.binding['portalTarget']['database'] and proof['images'] == self.binding['previousImages'])
        require(proof['kind'] == 'preauthority-legacy-source' and proof['inventoryIdentity'] == self.binding['inventoryIdentity'] and proof['targetImages'] == self.binding['candidate']['images'])
        require(proof['dataFingerprints']['portalDatabase'] == self.request['baseline']['dataFingerprint'] and proof['dataFingerprints']['portalUploads'] == self.request['baseline']['uploadsFingerprint'])
        for artifact in proof['artifacts']:
            require(digest(self.artifacts[artifact['name']]) == artifact['sha256'] and len(self.artifacts[artifact['name']]) == artifact['size'])
        expected_manifest = ''.join(digest(self.artifacts[name]) + '  ' + name + '\n' for name in self.state.LEGACY_ARTIFACTS).encode()
        require(self.artifacts['manifest.sha256'] == expected_manifest)
        require(digest(expected_manifest) == self.request['recovery']['manifestSha256'])
        require(uploads_fingerprint(self.artifacts['uploads.tar.gz']) == self.request['baseline']['uploads'])
        require(runtime._tar_tree(io.BytesIO(self.artifacts['uploads.tar.gz']), compressed=True) == self.request['baseline']['uploadsFingerprint'])
        require(digest(canonical(self.request['baseline'])) == self.request['recovery']['securityProfileSha256'])

    def boundary(self):
        mark('boundary')
        require(not self.lease.closed)
        actual = os.fstat(self.lease.fileno())
        require({'device': actual.st_dev, 'inode': actual.st_ino} == self.binding['lease'])
        # No lock reacquisition on a different file: compare the retained inode.
        path_info = os.stat(self.directory / 'lease')
        require((path_info.st_dev, path_info.st_ino) == (actual.st_dev, actual.st_ino))
        if os.name != 'nt':
            import fcntl
            with open(self.directory / 'lease', 'rb') as contender:
                try:
                    fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    fcntl.flock(contender.fileno(), fcntl.LOCK_UN)
                    require(False)
        for name, approved in self.request['helpers'].items():
            require(digest(private_bytes(self.directory / name)) == approved)
        body = self.state.read_state(str(self.directory), repair_head=False)[2]
        self.state.assert_install_matches(body, self.binding)
        require(body['admission'] == 'closed' and body['restoreIntent'] is None and body['workerHold'] is True)
        require(body['installIntent']['stage'] in ('reserved', 'portal_grants_pending'))
        self.operations.fence(self.binding, self.request['baseline'], self.request['fenceProfile'])
        return body

    def execute(self, interrupt=None):
        self.boundary()
        mark('checkpoint')
        self.state.begin_install_recovery(str(self.directory), self.binding, self.request['recovery'])
        def stage():
            return self.boundary()['installIntent']['recovery']['stage']
        def advance(value):
            self.boundary()
            mark('checkpoint')
            self.state.advance_install_recovery(str(self.directory), self.binding, value)
        if stage() == 'reserved':
            advance('database_restore_pending')
        if stage() == 'database_restore_pending':
            if not self.operations.database_matches(self.request['baseline']):
                self.boundary()
                mark('database_restore')
                self.operations.restore_database(self.artifacts['postgres.dump'])
                if interrupt == 'database':
                    raise Refused('isolated_b0_test_interruption')
            require(self.operations.database_matches(self.request['baseline']))
            advance('database_restored')
        if stage() == 'database_restored':
            advance('uploads_restore_pending')
        if stage() == 'uploads_restore_pending':
            self.boundary()
            mark('uploads_clear')
            self.operations.clear_uploads()
            self.boundary()
            mark('uploads_extract')
            self.operations.extract_uploads(self.artifacts['uploads.tar.gz'])
            if interrupt == 'uploads':
                raise Refused('isolated_b0_test_interruption')
            require(self.operations.uploads() == self.request['baseline']['uploads'])
            advance('uploads_restored')
        require(self.operations.database_matches(self.request['baseline']) and self.operations.uploads() == self.request['baseline']['uploads'])
        if stage() == 'uploads_restored':
            advance('data_verified_readiness_pending')
        require(stage() == 'data_verified_readiness_pending')
        return {'kind': 'isolated-b0-recovery-proof', 'dataVerified': True, 'admissionClosed': True,
                'readinessPending': True, 'productionAuthorized': False, 'applicationRollbackExecuted': False}


def native_qualification():
    # This is an isolated resource creator, not a production request dispatcher.
    require(sys.platform == 'linux' and os.geteuid() == 0)
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted')
    require(os.environ.get('PAYLOAD_B0_RECOVERY_DISPOSABLE') == '1')
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'))
    import fcntl
    import resource
    started = time.monotonic()
    nonce = secrets.token_hex(12)
    prefix = 'payload-b0-recovery-' + nonce
    root = Path(tempfile.mkdtemp(prefix=prefix + '-', dir='/var/tmp'))
    os.chmod(root, 0o700)
    created = []
    volume_receipts = {}
    db_id = None
    helpers = []
    helper_root = root / 'helpers'
    helper_root.mkdir(mode=0o700)
    owned_pids = {os.getpid()}
    phase = 'preflight'
    cleaning = False
    cleanup_deadline = None
    image_info = {}
    primary_failure = None
    child_location, child_failure = 'unknown', 'none'

    def command(args, data=None):
        remaining = (cleanup_deadline if cleaning else started + 210) - time.monotonic()
        require(remaining > 0)
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (CAP, CAP))
        with tempfile.TemporaryFile() as out:
            process = subprocess.run(args, input=data, stdout=out, stderr=subprocess.DEVNULL,
                                     timeout=min(20, remaining), env={'PATH': os.environ['PATH'], 'HOME': '/root'}, preexec_fn=limits)
            require(process.returncode == 0)
            out.seek(0)
            raw = out.read(CAP + 1)
            require(len(raw) <= CAP)
            return raw

    def docker(*args, data=None):
        return command(['docker', '--context', 'default', *args], data)

    def volume(key):
        name = prefix + '-' + key
        value = json.loads(docker('volume', 'inspect', name))[0]
        require(value['Name'] == name and value['Driver'] == 'local' and not value.get('Options'))
        require(value['Labels'] == {'io.ownerinc.b0-recovery': nonce, 'com.docker.compose.project': prefix, 'com.docker.compose.volume': key})
        require(value['Scope'] == 'local' and os.path.isabs(value['Mountpoint']))
        receipt = runtime._volume_receipt(value)
        if key in volume_receipts:
            require(receipt == volume_receipts[key])
        return receipt

    def db_inspect(running=True):
        value = json.loads(docker('inspect', db_id or prefix + '-postgres'))[0]
        require((db_id is None or value['Id'] == db_id) and value['Name'] == '/' + prefix + '-postgres' and value['Config']['Image'] == PG)
        require(value['Image'] == image_info[PG]['Id'] and value['Config']['Labels'] == dict(image_info[PG]['Config'].get('Labels') or {}, **{'io.ownerinc.b0-recovery': nonce}))
        require(value['HostConfig']['NetworkMode'] == 'none' and not value['HostConfig']['PortBindings'])
        require(value['HostConfig']['ReadonlyRootfs'] is True and value['HostConfig']['Privileged'] is False)
        require(value['HostConfig']['Binds'] in ([prefix + '-portalPostgres:/var/lib/postgresql/data'], [prefix + '-portalPostgres:/var/lib/postgresql/data:rw']))
        if running:
            require(value['State']['Running'] and not value['State']['Paused'] and not value['State']['Restarting'])
        require([(m['Name'], m['Destination'], m['RW']) for m in value['Mounts'] if m['Type'] == 'volume'] == [(prefix + '-portalPostgres', '/var/lib/postgresql/data', True)])
        require(all(m['Type'] in ('tmpfs', 'volume') for m in value['Mounts']))
        return value['Id']

    def sql(text):
        db_inspect()
        return docker('exec', '-i', db_id, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'portal', data=text.encode())

    def dump(*options):
        db_inspect()
        return docker('exec', db_id, 'pg_dump', '-U', 'postgres', '-d', 'portal', *options)

    def storage(args, raw=None, writable=False, key='portalUploads'):
        volume(key)
        # Fixed ephemeral helper; it owns no application network or credentials.
        name = prefix + '-storage-' + str(os.getpid()) + '-' + str(len(helpers))
        entry = {'name': name, 'volume': prefix + '-' + key, 'id': None, 'removed': False}
        helpers.append(entry)
        runtime.STATE._write_exclusive(str(helper_root / (name + '.json')), canonical(entry), 0o600)
        entry['id'] = docker('create', '-i', '--pull', 'never', '--name', name, '--network', 'none', '--read-only',
                             '--memory', '64m', '--pids-limit', '32', '--cpus', '0.5',
                             '--label', 'io.ownerinc.b0-recovery=' + nonce, '--volume', entry['volume'] + ':/data' + ('' if writable else ':ro'),
                             '--entrypoint', 'sh', NGINX, '-ceu', args).decode().strip()
        runtime.STATE._atomic_replace(str(helper_root / (name + '.json')), canonical(entry), 0o600)
        try:
            result = docker('start', '-a', '-i', entry['id'], data=raw)
            observed = json.loads(docker('inspect', entry['id']))[0]
            require(not observed['State']['Running'] and observed['State']['ExitCode'] == 0)
            return result
        finally:
            remove_helper(entry)

    def remove_helper(entry):
        require(set(entry) == {'name', 'volume', 'id', 'removed'} and entry['removed'] is False)
        match = re.fullmatch(re.escape(prefix) + r'-storage-([0-9]+)-[0-9]+', entry['name'])
        require(match is not None and int(match[1]) in owned_pids | {os.getpid()})
        require(entry['volume'] in {prefix + '-' + k for k in ('portalPostgres', 'portalUploads', 'cmsEvidence')})
        require(entry['id'] is None or re.fullmatch('[a-f0-9]{64}', entry['id']))
        value = json.loads(docker('inspect', entry['id'] or entry['name']))[0]
        require(value['Name'] == '/' + entry['name'] and (entry['id'] is None or value['Id'] == entry['id']))
        require(value['Config']['Image'] == NGINX and value['Image'] == image_info[NGINX]['Id'] and value['Config']['Labels'] == dict(image_info[NGINX]['Config'].get('Labels') or {}, **{'io.ownerinc.b0-recovery': nonce}))
        require(value['HostConfig']['NetworkMode'] == 'none' and not value['HostConfig']['PortBindings'])
        require(value['HostConfig']['ReadonlyRootfs'] is True and value['HostConfig']['Privileged'] is False)
        require(len(value['Mounts']) == 1 and value['Mounts'][0]['Type'] == 'volume' and value['Mounts'][0]['Name'] == entry['volume'] and value['Mounts'][0]['Destination'] == '/data')
        docker('rm', '--force', value['Id'])
        (helper_root / (entry['name'] + '.json')).unlink()
        entry['removed'] = True

    try:
        require(json.loads(docker('context', 'inspect', 'default'))[0]['Endpoints']['docker']['Host'] == 'unix:///var/run/docker.sock')
        for image in (PG, NGINX):
            image_info[image] = json.loads(docker('image', 'inspect', image))[0]
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_info[image]['Id']))
        closure = {}
        for name in HELPERS:
            raw = (Path(__file__).resolve().parent / name).read_bytes()
            closure[name] = digest(raw)
            (root / name).write_bytes(raw)
            os.chmod(root / name, 0o600)
        runtime = load_helpers(root, closure)
        S = runtime.STATE
        db_source = Path(__file__).resolve().parent.parent / 'api' / 'db'
        schema_source = (db_source / 'schema.sql').read_bytes()
        migration_sources = {version: (db_source / 'migrations' / (version + '.sql')).read_bytes() for version in S.PORTAL_MIGRATIONS}
        source_material = {'helpers': closure, 'schema': digest(schema_source), 'migrations': {v: digest(raw) for v, raw in migration_sources.items()}}
        phase = 'create_resources'
        for key in ('portalPostgres', 'portalUploads', 'cmsEvidence'):
            require(not docker('volume', 'ls', '-q', '--filter', 'name=^' + prefix + '-' + key + '$').strip())
            created.append(('volume', key))
            docker('volume', 'create', '--label', 'io.ownerinc.b0-recovery=' + nonce,
                   '--label', 'com.docker.compose.project=' + prefix, '--label', 'com.docker.compose.volume=' + key, prefix + '-' + key)
            volume_receipts[key] = volume(key)
        require(not docker('ps', '--all', '-q', '--filter', 'name=^/' + prefix + '-postgres$').strip())
        created.append(('container', prefix + '-postgres'))
        db_id = docker('run', '-d', '--pull', 'never', '--name', prefix + '-postgres', '--label', 'io.ownerinc.b0-recovery=' + nonce,
                       '--network', 'none', '--read-only', '--memory', '384m', '--cpus', '1', '--pids-limit', '128',
                       '--tmpfs', '/var/run/postgresql', '--tmpfs', '/tmp', '--volume', prefix + '-portalPostgres:/var/lib/postgresql/data',
                       '-e', 'POSTGRES_PASSWORD=' + secrets.token_hex(24), '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust', '-e', 'POSTGRES_DB=portal', PG).decode().strip()
        require(re.fullmatch('[a-f0-9]{64}', db_id))
        for attempt in range(30):
            try:
                sql('SELECT 1;')
                break
            except Exception:
                require(attempt < 29)
                time.sleep(0.5)
        phase = 'capture_baseline'
        sql(schema_source.decode('utf-8'))
        for version, migration in migration_sources.items():
            require(re.fullmatch('[0-9]{3}_[a-z0-9_]+', version))
            if sql("SELECT count(*) FROM schema_migrations WHERE version='" + version + "';").strip() == b'0':
                sql('BEGIN;\n' + migration.decode('utf-8') + "\nINSERT INTO schema_migrations(version) VALUES ('" + version + "');\nCOMMIT;")
        versions = json.loads(sql('SELECT json_agg(version ORDER BY version) FROM schema_migrations;'))
        require(versions == S.PORTAL_MIGRATIONS)
        password = secrets.token_hex(24)
        cron_password = secrets.token_hex(24)
        sql("CREATE ROLE portal_api LOGIN PASSWORD '" + password + "'; CREATE ROLE portal_cron LOGIN PASSWORD '" + cron_password + "'; "
            "CREATE TABLE public.recovery_records(id integer PRIMARY KEY, body text); "
            "INSERT INTO public.recovery_records VALUES(1,'original'),(2,'preserved'); "
            "GRANT SELECT ON public.recovery_records TO portal_api,portal_cron;")
        def authenticate_role(role, secret):
            require(role in ('portal_api', 'portal_cron'))
            return docker('exec', '-i', db_id, 'sh', '-ceu',
                          'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -XqAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U ' + role + ' -d portal -c "SELECT current_user"',
                          data=(secret + '\n').encode()).strip()
        for role, credential in (('portal_api', password), ('portal_cron', cron_password)):
            require(authenticate_role(role, credential) == role.encode())
            try:
                authenticate_role(role, 'incorrect-fixture-password')
            except Refused:
                pass
            else:
                require(False)
        storage("printf original > /data/original.txt; printf nested > /data/nested.txt", writable=True)
        storage("printf unrelated > /data/sentinel", writable=True, key='cmsEvidence')
        evidence = storage('cat /data/sentinel', key='cmsEvidence')
        identity = json.loads(sql("SELECT json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'databaseName',current_database());"))
        security_sql = "SELECT json_build_object('roles',(SELECT json_agg(row(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)::text ORDER BY rolname) FROM pg_roles),'memberships',(SELECT json_agg(m ORDER BY roleid,member,grantor) FROM pg_auth_members m),'databaseAcl',(SELECT datacl::text FROM pg_database WHERE datname=current_database()),'settingsPresent',EXISTS(SELECT 1 FROM pg_db_role_setting),'owners',(SELECT json_agg(row(c.relname,r.rolname)::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public'));"
        # Only the fixture table's table-level ACL may drift. Column, function,
        # schema, sequence/other table and default ACL drift remains a refusal.
        security_sql = security_sql.replace("'owners',", "'otherAcls',(SELECT json_agg(row(c.relname,c.relacl)::text ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname<>'recovery_records'),'columnAcls',(SELECT json_agg(row(c.relname,a.attname,a.attacl)::text ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attacl IS NOT NULL),'functionAcls',(SELECT json_agg(row(p.oid::regprocedure::text,p.proacl)::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'schemaAcl',(SELECT nspacl::text FROM pg_namespace WHERE nspname='public'),'defaultAcls',(SELECT json_agg(row(defaclrole,defaclnamespace,defaclobjtype,defaclacl)::text ORDER BY defaclrole,defaclnamespace,defaclobjtype) FROM pg_default_acl),'owners',")
        roles = digest(sql(security_sql))
        schema_bytes = normalize_dump(dump('--schema-only', '--no-privileges'))
        schema = digest(schema_bytes)
        db_fingerprint = digest(normalize_dump(dump()))
        raw_uploads = storage('tar -czf - -C /data .')
        baseline = {'database': db_fingerprint, 'schema': schema, 'roles': roles, 'uploads': uploads_fingerprint(raw_uploads),
                    'dataFingerprint': runtime._data_fingerprint('postgres', isolated_query=sql),
                    'uploadsFingerprint': runtime._tar_tree(io.BytesIO(raw_uploads), compressed=True)}
        S.initialize(str(root), digest(prefix.encode()))
        key = private_bytes(root / 'payload-control.key', 32)
        (root / 'lease').touch(mode=0o600)
        with open(root / 'lease', 'rb') as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            info = os.fstat(lease.fileno())
            # Application identities here are TEST protocol fixtures, not built
            # application qualification. Native targets use the real pins above.
            images = {name: 'ghcr.io/ownerinc/ownerinc-portal-' + name + '@sha256:' + digest((name + prefix).encode()) for name in ('api', 'cron', 'cms')}
            previous = {name: images[name] for name in ('api', 'cron')}
            material = digest(canonical(source_material))
            binding = {'bindingVersion': 2, 'candidate': {'schemaVersion': 1, 'purpose': 'isolated-recovery-producer', 'commit': 'a' * 40,
                       'runId': '1', 'runAttempt': '1', 'images': images, 'candidateSha256': digest(prefix.encode()), 'sourceMaterialSha256': material},
                       'candidateRelease': str(root / 'releases' / ('a' * 40)), 'sourceRelease': str(root / 'releases' / material[:40]),
                       'previousImages': previous, 'inventoryIdentity': digest(prefix.encode()), 'lease': {'device': info.st_dev, 'inode': info.st_ino},
                       'portalTarget': {'database': identity, 'volumes': {k: volume_receipts[k] for k in ('portalPostgres', 'portalUploads')}},
                       'b0': {'directory': str(root / 'b0'), 'proofSha256': ''}}
            artifacts = {'postgres.dump': dump('--format=custom'), 'uploads.tar.gz': raw_uploads}
            proof = {'schemaVersion': 1, 'kind': 'preauthority-legacy-source', 'phase': 'preauthority', 'authority': {'mode': 'legacy', 'epoch': 1},
                     'protocol': {'status': 'absent', 'coverage': 'not-applicable'}, 'inventoryIdentity': binding['inventoryIdentity'], 'images': previous, 'targetImages': images,
                     'source': {'portal': identity, 'cms': None}, 'migrations': {'portal': {'versions': versions, 'fingerprint': digest(S.canonical(versions))}, 'cms': None, 'nativeCatalogFingerprint': None},
                     'dataFingerprints': {'portalDatabase': baseline['dataFingerprint'], 'portalUploads': baseline['uploadsFingerprint'], 'cmsDatabase': None, 'cmsUploads': None},
                     'artifacts': [{'name': name, 'sha256': digest(raw), 'size': len(raw)} for name, raw in artifacts.items()], 'createdAtUtc': '2026-10-14T00:00:00Z'}
            # Migration history was queried after applying the real source SQL.
            # Application compatibility still requires separate image/grant acceptance.
            artifacts['manifest.sha256'] = ''.join(digest(artifacts[n]) + '  ' + n + '\n' for n in S.LEGACY_ARTIFACTS).encode()
            artifacts['preauthority-proof.json'] = S.canonical(S.sign_envelope(S.validate_proof_body(proof), key))
            binding['b0']['proofSha256'] = digest(artifacts['preauthority-proof.json'])
            (root / 'b0').mkdir(mode=0o700)
            for name, raw in artifacts.items():
                S._write_exclusive(str(root / 'b0' / name), raw, 0o600)
            S.transition(str(root), lambda body: body.update(admission='closed', plannedReleaseImages=images, latestProofSha256=binding['b0']['proofSha256'], legacySourceProofSha256=binding['b0']['proofSha256']))
            S.reserve_install(str(root), binding, proof, binding['b0']['proofSha256'], {'nonce': digest(prefix.encode()), 'volumes': {}, 'containers': {}})
            fence_profile = {'scope': prefix, 'databaseContainerId': db_id, 'network': 'none', 'writers': [], 'evidenceVolume': volume_receipts['cmsEvidence']}
            recovery = {'recoveryVersion': 1, 'purpose': 'isolated-b0-recovery', 'installBindingSha256': digest(S.canonical(binding)),
                        'originStateSha256': S.read_state(str(root))[3], 'b0ProofSha256': binding['b0']['proofSha256'], 'manifestSha256': digest(artifacts['manifest.sha256']),
                        'portalTarget': binding['portalTarget'], 'sourceRelease': binding['sourceRelease'], 'previousImages': previous,
                        'securityProfileSha256': digest(canonical(baseline)), 'fenceProfileSha256': digest(canonical(fence_profile)),
                        'restoreProfile': 'same-target-legacy-objects-acl-v1'}
            request = S.canonical(S.sign_envelope({'kind': 'isolated-b0-recovery-request-v1', 'binding': binding, 'recovery': recovery,
                                                  'helpers': closure, 'artifacts': {n: digest(b) for n, b in artifacts.items()}, 'baseline': baseline, 'fenceProfile': fence_profile}, key))

            class Operations:
                def fence(self, expected, approved, profile):
                    require(profile == {'scope': prefix, 'databaseContainerId': db_id, 'network': 'none', 'writers': [], 'evidenceVolume': volume_receipts['cmsEvidence']})
                    db_inspect()
                    require(json.loads(sql("SELECT json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'databaseName',current_database());")) == expected['portalTarget']['database'])
                    for name, receipt in expected['portalTarget']['volumes'].items():
                        require(volume(name) == receipt)
                    require(volume('cmsEvidence') == profile['evidenceVolume'])
                    require(set(docker('volume', 'ls', '-q', '--filter', 'label=io.ownerinc.b0-recovery=' + nonce).decode().splitlines()) == {prefix + '-' + name for name in volume_receipts})
                    require(docker('ps', '--all', '--no-trunc', '--filter', 'label=io.ownerinc.b0-recovery=' + nonce, '--format', '{{.ID}}').decode().strip() == db_id)
                    # Read only IDs and whether a mount consumes these exact
                    # owned volumes, not another project's environment/topology.
                    all_ids = docker('ps', '--all', '--no-trunc', '--format', '{{.ID}}').decode().splitlines()
                    require(len(all_ids) <= 512 and all(re.fullmatch('[a-f0-9]{64}', value) for value in all_ids))
                    expression = '{{.Id}} {{range .Mounts}}{{if or ' + ' '.join('(eq .Name "' + prefix + '-' + name + '")' for name in ('portalPostgres', 'portalUploads', 'cmsEvidence')) + '}}owned{{end}}{{end}}'
                    if all_ids:
                        for line in docker('inspect', '--format', expression, *all_ids).decode().splitlines():
                            parts = line.split()
                            require(len(parts) == 1 or (len(parts) == 2 and parts[0] == db_id and parts[1] == 'owned'))
                    require(sql("SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid();").strip() == b'0')
                    require(sql("SELECT count(*) FROM pg_prepared_xacts;").strip() == b'0')
                    require(sql("SELECT current_setting('server_version_num')::int BETWEEN 160000 AND 169999 AND current_setting('shared_preload_libraries')='' AND NOT pg_is_in_recovery() AND NOT EXISTS(SELECT 1 FROM pg_subscription) AND NOT EXISTS(SELECT 1 FROM pg_replication_slots) AND NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname NOT IN ('plpgsql','pgcrypto')) AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE backend_type NOT IN ('client backend','autovacuum launcher','autovacuum worker','background writer','checkpointer','walwriter','archiver','logical replication launcher'));").strip() == b't')
                    mark('security_compare')
                    require(digest(sql(security_sql)) == approved['roles'])
                    mark('role_authentication')
                    require(authenticate_role('portal_api', password) == b'portal_api')
                    require(authenticate_role('portal_cron', cron_password) == b'portal_cron')
                    mark('schema_dump')
                    observed_schema = dump('--schema-only', '--no-privileges')
                    mark('schema_normalization')
                    observed_schema = normalize_dump(observed_schema)
                    assert_schema_dump(schema_bytes, observed_schema, approved['schema'],
                                       (lambda before, after: capture_schema_discrepancy(root, before, after))
                                       if phase in ('recover_uploads_interruption', 'recover_final') else None)

                def database_matches(self, approved):
                    mark('database_dump_compare')
                    if digest(normalize_dump(dump())) != approved['database']:
                        return False
                    mark('database_data_compare')
                    return runtime._data_fingerprint('postgres', isolated_query=sql) == approved['dataFingerprint']

                def restore_database(self, raw):
                    db_inspect()
                    docker('exec', '-i', db_id, 'pg_restore', '--single-transaction', '--clean', '--if-exists', '--exit-on-error', '-U', 'postgres', '-d', 'portal', data=raw)

                def clear_uploads(self):
                    storage('find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +', writable=True)

                def extract_uploads(self, raw):
                    uploads_fingerprint(raw)
                    storage('tar -xzf - -C /data', raw, writable=True)

                def uploads(self):
                    mark('uploads_compare')
                    return uploads_fingerprint(storage('tar -czf - -C /data .'))

            operations = Operations()
            phase = 'unsupported_schema_negative'
            # Real unsupported-schema refusal before any recovery checkpoint or
            # destructive restore. Only this newly created test table is removed
            # by the fixture supervisor; the executor never repairs unknown DDL.
            head_before = S.read_state(str(root))[3]
            sql('CREATE TABLE public.b0_unexpected_fixture(id integer);')
            try:
                Executor(root, runtime, key, request, operations, lease).execute()
            except Refused:
                pass
            else:
                require(False)
            require(S.read_state(str(root))[3] == head_before)
            sql('DROP TABLE public.b0_unexpected_fixture;')
            phase = 'damage_fixture'
            sql("UPDATE recovery_records SET body='damaged'; REVOKE SELECT ON recovery_records FROM portal_api;")
            storage('printf damaged > /data/original.txt', writable=True)
            # Each attempt is a fresh child/coordinator and acquires a new open
            # lease description. Fault children exit after actual effects, without
            # appending the completion checkpoint. Parent never reuses their lease.
            fcntl.flock(lease.fileno(), fcntl.LOCK_UN)
            for fault in ('database', 'uploads', None):
                child_location, child_failure = 'unknown', 'child_exit'
                phase = {'database': 'recover_database_interruption', 'uploads': 'recover_uploads_interruption', None: 'recover_final'}[fault]
                reader, writer = os.pipe()
                child = os.fork()
                if child == 0:
                    os.close(reader)
                    mark('entry_authentication')
                    try:
                        with open(root / 'lease', 'rb') as child_lease:
                            fcntl.flock(child_lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                            outcome = Executor(root, runtime, key, request, operations, child_lease).execute(fault)
                            if fault is not None:
                                write_child_frame(writer, 'expected_interruption_missing')
                                os._exit(73)
                            mark('complete')
                            write_child_frame(writer, 'none', outcome)
                        os._exit(0)
                    except Exception as error:
                        failure, exit_code = failure_for_exception(error, fault)
                        write_child_frame(writer, failure)
                        os._exit(exit_code)
                os.close(writer)
                owned_pids.add(child)
                try:
                    while True:
                        completed, status = os.waitpid(child, os.WNOHANG)
                        if completed:
                            break
                        if time.monotonic() - started >= 210:
                            os.kill(child, 9)  # Only this unreaped, directly owned child.
                            os.waitpid(child, 0)
                            require(False)
                        time.sleep(0.05)
                    raw = os.read(reader, 1025)
                    child_location, child_failure = 'unknown', 'child_exit'
                    require(os.WIFEXITED(status))
                    require(os.WEXITSTATUS(status) in (0, 72, 73))
                    child_failure = 'malformed_frame'
                    frame = parse_child_frame(raw, os.WEXITSTATUS(status), fault)
                    child_location, child_failure = frame['location'], frame['failure']
                    require(os.WEXITSTATUS(status) == (72 if fault else 0))
                    child_location, child_failure = 'checkpoint', 'checkpoint_mismatch'
                    body = S.read_state(str(root), repair_head=False)[2]
                    check_child_checkpoint(body, fault)
                    if fault is None:
                        result = frame['proof']
                    child_location, child_failure = 'unknown', 'none'
                finally:
                    os.close(reader)
            phase = 'verify_preserved_evidence'
            require(storage('cat /data/sentinel', key='cmsEvidence') == evidence)
            require(authenticate_role('portal_api', password) == b'portal_api')
            require(authenticate_role('portal_cron', cron_password) == b'portal_cron')
            require(S.read_state(str(root))[2]['admission'] == 'closed')
        phase = 'complete'
    except Exception:
        primary_failure = phase
    finally:
        cleaning = True
        cleanup_deadline = time.monotonic() + 60
        cleanup_ok = True
        names = list(helper_root.iterdir())
        require(len(names) <= 128)
        for path in names:
            try:
                entry = json.loads(private_bytes(path, 4096))
                require(path.name == entry['name'] + '.json')
                remove_helper(entry)
            except Exception:
                cleanup_ok = False
        for kind, value in reversed(created):
            try:
                if kind == 'container':
                    observed_id = db_inspect(running=False)
                    docker('rm', '--force', observed_id)
                else:
                    volume(value)
                    docker('volume', 'rm', prefix + '-' + value)
            except Exception:
                cleanup_ok = False
        if primary_failure is not None:
            try:
                if child_failure.startswith('schema_'):
                    require((root / REPORT_NAME).exists())
                export_schema_discrepancy(root)
            except Exception:
                print('isolated_b0_schema_report_unavailable', file=sys.stderr)
        if primary_failure is None and cleanup_ok:
            shutil.rmtree(root)
        # Failed journal/B0/source closure stays private until hosted-runner
        # teardown; never publish its key, request, dump or filesystem path.
    if primary_failure or not cleanup_ok:
        raise Refused('isolated_b0_recovery_qualification_failed:' + (primary_failure or 'none') + ';child:' + child_location + ':' + child_failure + ';cleanup:' + ('none' if cleanup_ok else 'refused'))
    require(phase == 'complete')
    return dict(result, databaseAndUploadsInterruptionsReconciled=True, unrelatedEvidencePreserved=True,
                ownedResourcesRemoved=True, applicationCompatibilityQualified=False)


if __name__ == '__main__':
    try:
        require(sys.argv[1:] == ['--qualify'])
        print(json.dumps(native_qualification(), separators=(',', ':')))
    except Exception as error:
        message = str(error)
        pattern = r'isolated_b0_recovery_qualification_failed:(preflight|create_resources|capture_baseline|unsupported_schema_negative|damage_fixture|recover_database_interruption|recover_uploads_interruption|recover_final|verify_preserved_evidence|complete|none);child:(' + '|'.join(CHILD_LOCATIONS) + '):(' + '|'.join(CHILD_FAILURES) + r');cleanup:(none|refused)'
        print(message if re.fullmatch(pattern, message) else 'isolated_b0_recovery_qualification_failed:guard;child:unknown:unknown;cleanup:none', file=sys.stderr)
        sys.exit(1)
