#!/usr/bin/env python3
"""TEST-only projection bridge. No production authentication or collector."""
import importlib.util
from pathlib import Path
import sys
import json


def main():
    spec = importlib.util.spec_from_file_location('fence_fixture', Path(__file__).resolve().parents[2] / 'ops' / 'payload-control-runtime.py')
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024 or sys.argv[1:]:
        raise ValueError()
    request = runtime._strict_json(raw, 'fence_observation_invalid')
    if set(request) != {'testOnly', 'observation', 'context', 'topology', 'closure', 'now'} or request['testOnly'] is not True:
        raise ValueError()
    result = runtime.check_portal_destructive_fence(request['observation'], request['context'], request['topology'], request['closure'], now_monotonic=request['now'])
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('fence_topology_bridge_refused', file=sys.stderr)
        sys.exit(1)
