#!/usr/bin/python3
"""Forced OpenSSH read-only command on the independently provisioned witness.

Install with an authorized_keys restrict,command= entry, no PTY/forwarding and a
dedicated account. The launcher pins the external host key and this profile's
exact-byte digest. No command, origin, route or credential is accepted on stdin.
"""
import hashlib
import http.client
import json
import os
import re
import ssl
import stat
import sys
import time

PROFILE = '/etc/ownerinc/payload-witness/profile.json'
ORIGIN = 'portal.ownerinc.com.br'
ROUTES = ('/','/api/ready','/editorial/ready')


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()


def parse(raw):
    def pairs(items):
        result = {}
        for k,v in items:
            if k in result:
                raise ValueError('duplicate')
            result[k] = v
        return result
    result = json.loads(raw,object_pairs_hook=pairs)
    if canonical(result) + b'\n' != raw:
        raise ValueError('canonical')
    return result


def respond(raw, profile_raw, probe):
    request,profile = parse(raw),parse(profile_raw)
    if set(request) != {'kind','nonce','contextSha256','profileSha256'} or request['kind'] != 'production-b0-witness-request-v1':
        raise ValueError('request')
    if any(not isinstance(request[k],str) or not re.fullmatch('[0-9a-f]{64}',request[k]) for k in ('nonce','contextSha256','profileSha256')):
        raise ValueError('binding')
    if request['profileSha256'] != hashlib.sha256(profile_raw).hexdigest() or set(profile) != {'kind','routes'} or profile['kind'] != 'production-b0-witness-profile-v1':
        raise ValueError('profile')
    routes = []
    for path in ROUTES:
        status,body = probe(path)
        if type(status) is not int or status not in (403,404,503) or len(body) > 65536:
            raise ValueError('not_closed')
        routes.append({'route':path,'status':status,'bodySha256':hashlib.sha256(body).hexdigest()})
    if routes != profile['routes']:
        raise ValueError('unqualified_response')
    return dict(request,kind='production-b0-witness-response-v1',routes=routes)


def main():
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND',''):
        raise ValueError('forced_command_only')
    parent = os.path.dirname(PROFILE)
    while True:
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('profile_ancestry')
        if parent == os.path.dirname(parent):
            break
        parent = os.path.dirname(parent)
    fd = os.open(PROFILE,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o644:
            raise ValueError('profile')
        profile = stream.read(4097)
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096 or len(profile) > 4096:
        raise ValueError('budget')
    started = time.monotonic()
    def probe(path):
        with_connection = http.client.HTTPSConnection(ORIGIN,443,timeout=5,context=ssl.create_default_context())
        try:
            with_connection.request('GET',path,headers={'User-Agent':'Ownerinc-B0-Fence/1','Cache-Control':'no-cache'})
            response = with_connection.getresponse()
            body = response.read(65537)
            if time.monotonic() - started >= 18 or response.getheader('Location'):
                raise ValueError('budget_or_redirect')
            return response.status,body
        finally:
            with_connection.close()
    sys.stdout.buffer.write(canonical(respond(raw,profile,probe))+b'\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('witness_denied',file=sys.stderr)
        sys.exit(2)
