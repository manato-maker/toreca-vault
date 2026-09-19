# Toreca Vault v2 implementation status

This branch is isolated from production.

## Implemented foundation
- schemaVersion 2 state
- transaction/mutation idempotency
- product + condition inventory keys; store is not an inventory dimension
- FIFO lot consumption sorted by acquired date
- atomic failure on insufficient stock
- realized profit excludes unknown acquisition cost
- positive-inventory market target deduplication
- v1 -> v2 dry-run migration helper and comparison report
- regression tests for the core rules

## Not production-ready yet
API persistence, post-write reread verification, Gmail automation, market fetchers, health monitoring, backup/restore, full migration reconciliation, and smartphone acceptance testing still have to pass the build gate. Do not switch production to v2 yet.
