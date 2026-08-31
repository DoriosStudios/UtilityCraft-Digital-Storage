# Storage V2 transactional review

This companion note is normative and closes two recovery details in
`STORAGE_V2_DESIGN.md`.

## Recoverable multi-cell commits

Every manifest includes `transactionId`, defaulting to zero. A nonzero value is
reserved for future staged-manifest commits and is never eligible for normal
fallback reads.

The current two-cell protocol persists one paged intent containing both complete
post-states before either cell changes. It then indexes the intent, freezes both
cell ids in runtime, writes destination and source, and removes the intent only
after both writes succeed. Recovery discovers intents from both the bounded
index and their dynamic-property prefixes, then idempotently reapplies both
post-states before storage becomes ready.

An interrupted write can therefore expose one post-state temporarily only while
storage is locked. If an intent is unreadable, startup remains locked and retains
all intent data for diagnosis instead of guessing or deleting it.

## Rebuildable indexes

The fixed 256-id index buckets are accelerators, never sources of item data. A
missing, malformed, or failed bucket write cannot make a valid cell/network
record disposable.

Recovery rebuilds a bucket by filtering dynamic-property ids for valid manifest
bases within the id range implied by the corresponding next-id counter. It then
validates candidate manifests before restoring the bucket.
