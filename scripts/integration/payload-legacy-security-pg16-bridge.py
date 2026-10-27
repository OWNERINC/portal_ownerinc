#!/usr/bin/env python3
"""Disposable qualification bridge, not a host collector or production profile."""
import importlib.util
import json
from pathlib import Path
import sys


def load_runtime():
    path = Path(__file__).resolve().parents[2] / 'ops' / 'payload-control-runtime.py'
    spec = importlib.util.spec_from_file_location('legacy_security_qualification', path)
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    return runtime


def build_current_contract(runtime, observation):
    state, inventory_module = runtime.STATE, runtime.INVENTORY
    root = '/disposable/payload-legacy-security'
    inventory = inventory_module.production_inventory(root, root + '/runtime', root + '/releases',
        root + '/current-release', root + '/runtime/deploy.lock', '/disposable/daily', '/disposable/backup',
        '/disposable/protection', '/disposable/env', root + '/runtime/compose', root + '/runtime/payload', 'portal')
    # All authority/image hashes below are synthetic fixtures. No signature,
    # source authentication, installation or production approval is asserted.
    images = {name: 'ghcr.io/ownerinc/ownerinc-portal-' + name + '@sha256:' + 'a' * 64
              for name in ('api', 'cron', 'cms')}
    authority = {name: 'a' * 64 for name in ('sourceApprovalSha256', 'policySha256', 'recordSha256')}
    record = {'commit': 'a' * 40, 'runId': '1', 'runAttempt': '1', 'images': images,
              'candidateSha256': 'b' * 64, 'recoveryReportSha256': 'c' * 64,
              'qualifiedManifestSha256': 'd' * 64, 'archiveSha256': 'e' * 64, 'policySha256': 'a' * 64}
    binding = {'bindingVersion': 4, 'authority': authority, 'sourceCommit': 'b' * 40,
        'project': inventory['project'], 'candidate': state.production_candidate(record),
        'candidateRelease': root + '/releases/' + 'a' * 40, 'sourceRelease': root + '/releases/' + 'b' * 40,
        'previousImages': {name: images[name] for name in ('api', 'cron')},
        'b0': {'directory': '/disposable/backup/b0', 'proofSha256': 'f' * 64},
        'inventoryIdentity': inventory_module.identity(inventory), 'lease': {'device': 1, 'inode': 2},
        'sharedCluster': inventory['databaseCluster'],
        'portalTarget': {'database': observation['database'], 'volumes': {name: {
            'name': name, 'driver': 'local', 'mountpoint': '/disposable/' + name, 'fingerprint': '0' * 64}
            for name in ('portalPostgres', 'portalUploads')}}}
    binding = state.parse_canonical(state.canonical(binding) + b'\n', 'invalid_fixture')
    state.validate_install_binding(binding)
    creation = state.production_install_creation(binding, '2' * 64)
    approval = {'hostBaseline': {'currentCommit': binding['sourceCommit'], 'legacyImages': binding['previousImages'],
                                'inventoryIdentity': binding['inventoryIdentity']},
                'admission': {'policySha256': 'a' * 64, 'recordSha256': 'a' * 64, 'archiveSha256': 'e' * 64}}
    body = {'schemaVersion': 2, 'phase': 'preauthority', 'cmsStatus': 'cold',
        'authority': {'mode': 'legacy', 'epoch': 1}, 'workerHold': True, 'admission': 'closed',
        'sequence': 1, 'previousStateSha256': '1' * 64, 'restoreIntent': None,
        'installIntent': {'binding': binding, 'stage': 'reserved', 'cmsTarget': None, 'creation': creation},
        'latestProofSha256': 'f' * 64, 'legacySourceProofSha256': 'f' * 64,
        'releaseImages': None, 'plannedReleaseImages': images, 'rollbackTargetImages': None,
        'nativeCatalogFingerprint': None, 'inventoryIdentity': binding['inventoryIdentity']}
    body = state.parse_canonical(state.canonical(body) + b'\n', 'invalid_fixture')
    state.validate_state_body(body)
    return body, approval, record, inventory, authority


def main():
    runtime = load_runtime()
    if sys.argv[1:] == ['--sql']:
        print(runtime.portal_legacy_security_observation_sql(), end='')
        return
    if sys.argv[1:] != ['--check']:
        raise ValueError('unsupported bridge operation')
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('bridge input limit')
    request = runtime._strict_json(raw, 'invalid_fixture')
    if set(request) != {'observation', 'profileObservation'}:
        raise ValueError('invalid fixture')
    observation = runtime.validate_portal_legacy_security_observation(request['observation'])
    body, approval, record, inventory, authority = build_current_contract(runtime, observation)
    binding = body['installIntent']['binding']
    profile = None if request['profileObservation'] is None else {
        'kind': 'portal-legacy-security-profile-v1', 'sourceCommit': binding['sourceCommit'],
        'previousImages': binding['previousImages'], 'observation': request['profileObservation']}
    result = runtime.check_portal_legacy_security_baseline(observation, body, approval, record, inventory, authority, profile)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never expose SQL responses, catalog contents, credentials or stderr.
        print('legacy_security_qualification_bridge_failed', file=sys.stderr)
        sys.exit(1)
