# Payload B0 Native Inventory Fix

## Problem

The required native isolated B0 qualification loads the real payload control runtime and calls `_data_fingerprint()` during baseline capture. The runtime resolves the Portal database through the protected inventory, but the disposable fixture never creates `payload-control-inventory.json`. Both GitHub attempts therefore fail closed with `inventory_unavailable` before candidate images are published.

## Design

The disposable fixture will create a real schema-v3 inventory through the authenticated `payload-control-inventory.py` helper immediately after loading the helper closure. The inventory will use only fixture-owned paths under the private `/var/tmp/payload-b0-recovery-*` root and the fixed fixture database name `portal`.

The fixture will calculate the inventory identity from the created document and use that exact value for:

- the candidate binding `inventoryIdentity`;
- payload state initialization;
- all existing signed recovery requests and proofs derived from that binding.

This preserves the production runtime contract instead of bypassing `_inventory()`, injecting an in-memory cache, or adding a caller-selected database argument.

## Security and Isolation

- The inventory is root-owned, mode `0600`, under the existing private disposable root.
- No production paths, credentials, services, volumes, or inventory are read or modified.
- The existing cleanup removes the inventory with the rest of the successful fixture root.
- Failure remains fail-closed and leaves only private hosted-runner evidence until runner teardown.
- No compatibility fallback is added to production runtime code.

## Verification

- Add a portable contract test proving inventory creation precedes `_data_fingerprint()` and that the same computed identity feeds the binding and state initialization.
- Run the focused recovery tests locally.
- Run `npm run verify` and `git diff --check`.
- Open a narrowly scoped PR and require Linux CI.
- After merge, issue a fresh authorization and rerun `publish_candidate_only`; do not reuse the failed nonce.

## Scope

Only the disposable B0 fixture, its unit contract, and matching operational evidence documentation change. Candidate packaging, production inventory, receiver, CMS installation, routing, workers, authority, and cutover remain unchanged.
