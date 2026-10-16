#!/usr/bin/python3
import hashlib
import importlib.machinery
import json
import os
import re
import sys


MAX_FRAME = 4096
MAX_DEPTH = 16
MAX_SAFE_INTEGER = 2**53 - 1
HEX_64 = re.compile(r'[0-9a-f]{64}')
HEX_40 = re.compile(r'[0-9a-f]{40}')
LAUNCHER = '/usr/local/libexec/ownerinc-payload-prepare.py'


def require(condition):
    if not condition:
        raise ValueError('denied')


def keys(value, expected):
    require(isinstance(value, dict))
    require(set(value) == set(expected.split()))


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(',', ':'),
        ensure_ascii=True,
    ).encode('ascii')


def _bounded_depth(value, depth=1):
    require(depth <= MAX_DEPTH)
    if isinstance(value, dict):
        for key, item in value.items():
            require(isinstance(key, str))
            _bounded_depth(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _bounded_depth(item, depth + 1)


def strict_json(raw, maximum=MAX_FRAME):
    require(type(raw) is bytes and type(maximum) is int)
    require(0 < len(raw) <= maximum)

    def pairs(items):
        value = {}
        for key, item in items:
            require(isinstance(key, str) and key not in value)
            value[key] = item
        return value

    def reject_constant(_value):
        raise ValueError('denied')

    value = json.loads(
        raw.decode('utf-8'),
        object_pairs_hook=pairs,
        parse_constant=reject_constant,
    )
    _bounded_depth(value)
    require(canonical(value) + b'\n' == raw)
    return value


def validate_request(value):
    keys(value, 'schemaVersion kind operation nonce approvalSha256')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1)
    require(value['kind'] == 'payload-production-context-request-v1')
    require(value['operation'] == 'collect-context')
    require(isinstance(value['nonce'], str) and HEX_64.fullmatch(value['nonce']))
    require(
        isinstance(value['approvalSha256'], str)
        and HEX_64.fullmatch(value['approvalSha256'])
    )
    return value


def _integer(value, minimum, maximum=None):
    require(type(value) is int and value >= minimum
            and (maximum is None or value <= maximum))


def validate_response(value, expected_nonce, expected_approval):
    keys(
        value,
        'schemaVersion kind operation nonce context '
        'sourceAuthenticated inventoryAuthenticated stateAuthenticated leaseVerified '
        'destructiveOperationAuthorized installationExecuted deploymentAuthorized '
        'productionAuthorized',
    )
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1)
    require(value['kind'] == 'payload-production-context-observation-v1')
    require(value['operation'] == 'collect-context')
    require(
        isinstance(value['nonce'], str)
        and HEX_64.fullmatch(value['nonce'])
        and value['nonce'] == expected_nonce
    )

    context = value['context']
    keys(
        context,
        'approvalSha256 sourceCommit inventoryIdentity stateSha256 stateSequence '
        'pid processStart leaseDevice leaseInode',
    )
    require(
        isinstance(context['approvalSha256'], str)
        and HEX_64.fullmatch(context['approvalSha256'])
        and context['approvalSha256'] == expected_approval
    )
    require(
        isinstance(context['sourceCommit'], str)
        and HEX_40.fullmatch(context['sourceCommit'])
    )
    for field in ('inventoryIdentity', 'stateSha256'):
        require(isinstance(context[field], str) and HEX_64.fullmatch(context[field]))
    _integer(context['stateSequence'], 0)
    _integer(context['pid'], 1, MAX_SAFE_INTEGER)
    _integer(context['processStart'], 1, MAX_SAFE_INTEGER)
    _integer(context['leaseDevice'], 0)
    _integer(context['leaseInode'], 1)

    for field in (
        'sourceAuthenticated',
        'inventoryAuthenticated',
        'stateAuthenticated',
        'leaseVerified',
    ):
        require(value[field] is True)
    for field in (
        'destructiveOperationAuthorized',
        'installationExecuted',
        'deploymentAuthorized',
        'productionAuthorized',
    ):
        require(value[field] is False)
    require(len(canonical(value)) + 1 <= MAX_FRAME)
    return value


def process_start_ticks():
    with open('/proc/self/stat', 'rb') as source:
        raw = source.read(MAX_FRAME + 1)
    require(0 < len(raw) <= MAX_FRAME and raw.endswith(b'\n'))
    raw = raw[:-1]
    closing = raw.rfind(b')')
    first_space = raw.find(b' ')
    require(first_space > 0 and closing > first_space + 1)
    require(int(raw[:first_space]) > 0)
    require(raw[first_space + 1:first_space + 2] == b'(')
    fields = raw[closing + 1:].strip().split()
    require(len(fields) >= 20)
    value = int(fields[19])
    require(value > 0)
    return value


def collect_context(request, launcher):
    request = validate_request(request)
    approval, captured, _, _, digest = launcher.context_material(
        request['approvalSha256']
    )
    require(digest == request['approvalSha256'])
    runtime, inventory, body, _ = launcher.inspect_install_host(approval, captured)
    lease = os.fstat(9)
    launcher.verify_inherited_lease()
    context = {
        'approvalSha256': digest,
        'sourceCommit': approval['hostBaseline']['currentCommit'],
        'inventoryIdentity': runtime.INVENTORY.identity(inventory),
        'stateSha256': hashlib.sha256(runtime.STATE.canonical(body)).hexdigest(),
        'stateSequence': body['sequence'],
        'pid': os.getpid(),
        'processStart': process_start_ticks(),
        'leaseDevice': lease.st_dev,
        'leaseInode': lease.st_ino,
    }
    launcher.verify_inherited_lease()
    response = {
        'schemaVersion': 1,
        'kind': 'payload-production-context-observation-v1',
        'operation': 'collect-context',
        'nonce': request['nonce'],
        'context': context,
        'sourceAuthenticated': True,
        'inventoryAuthenticated': True,
        'stateAuthenticated': True,
        'leaseVerified': True,
        'destructiveOperationAuthorized': False,
        'installationExecuted': False,
        'deploymentAuthorized': False,
        'productionAuthorized': False,
    }
    return validate_response(response, request['nonce'], digest)


def main(args=None):
    try:
        if args is None:
            args = sys.argv[1:]
        require(args == ['collect-context'])
        raw = sys.stdin.buffer.read(MAX_FRAME + 1)
        request = validate_request(strict_json(raw))
        sys.dont_write_bytecode = True
        launcher = importlib.machinery.SourceFileLoader(
            'ownerinc_payload_prepare', LAUNCHER
        ).load_module()
        response = collect_context(request, launcher)
        sys.stdout.buffer.write(canonical(response) + b'\n')
    except BaseException:
        sys.stderr.buffer.write(b'Production context collection denied.\n')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
