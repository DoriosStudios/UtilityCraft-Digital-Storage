# Digital Storage V2 Design

Status: implementation specification.

This document defines the rework that replaces item-count capacity with weighted
logical storage bytes and single-string records with incremental, transactional,
paged persistence. Existing cell capacity numbers remain unchanged, but represent
symbolic bytes instead of raw item count.

## 1. Goals and non-goals

Goals:

- One capacity number per cell, with no separate item-type limit.
- New types cost substantially more than more items of an existing type.
- Normal online operations remain in memory.
- Only changed cells and metadata are persisted.
- No serialized string approaches the dynamic-property string limit.
- Load, flush, recovery, and topology work can be spread across ticks.
- Interrupted writes are recoverable and idempotent.
- Portable cells retain their particular contents.
- Existing worlds migrate without deleting or clamping items.
- Native opaque-item vault behavior is preserved.

Non-goals:

- Logical bytes are not literal JSON bytes; format changes must not alter balance.
- V2 does not write a dynamic property for every item operation.
- V2 has no arbitrary hidden type cap.
- V2 does not promise to preserve changes made after the last committed flush if
  the process crashes without an orderly shutdown.

## 2. Capacity model

### 2.1 Defaults

```js
ITEMS_PER_STORAGE_UNIT = 8;
SIMPLE_TYPE_OVERHEAD_UNITS = 8;
DEFINED_TYPE_OVERHEAD_UNITS = 16;
OPAQUE_ITEM_UNITS = 64;
```

These are balance constants, not schema constants, and can be tuned before
implementation.

Item-key classes:

- Simple: normal type id, such as `minecraft:stone`.
- Defined: `ucds:item:<definitionId>`, normally a stackable item with a custom
  name or lore.
- Opaque: `ucds:vault:<pageId>:<slot>`, exactly one native non-stackable item.

### 2.2 Cost formula

```text
cost(key, amount <= 0) = 0
cost(simple, amount) = 8 + ceil(amount / 8)
cost(defined, amount) = 16 + ceil(amount / 8)
cost(opaque, 1) = 64
```

Opaque keys must always have amount one. Any other amount is corruption.

```text
cell.usedUnits = sum(cost(key, amount))
network.usedUnits = sum(cell.usedUnits)
network.capacityUnits = sum(cell.capacityUnits)
```

Type overhead is charged per physical cell. Splitting one key across three
cells pays three overheads. Reported usage therefore always matches a valid
physical allocation.

Exact capacity checks use cost deltas:

```text
insertDelta = cost(key, before + inserted) - cost(key, before)
removeDelta = cost(key, before) - cost(key, before - removed)
```

Adding up to the next eight-item boundary may cost zero bytes. Amounts, units,
revisions, and ids must remain safe integers.

Examples for a simple key:

| Contents in one cell | Logical bytes |
| --- | ---: |
| 1 item | 9 |
| 8 items | 9 |
| 64 items | 16 |
| 4,096 items | 520 |

A 1 KB cell holds up to 8,128 items of one simple type, 113 simple
one-item types, exactly 64 simple types with 64 items each, or 16 opaque items.
There is no explicit type maximum; capacity creates the natural maximum.

### 2.3 Existing capacities

| Cell | Capacity |
| --- | ---: |
| Storage Cell | 1 KB |
| Basic Storage Cell | 4 KB |
| Advanced Storage Cell | 16 KB |
| Expert Storage Cell | 64 KB |
| Ultimate Storage Cell | 400 KB |

`utilitycraft:ds.capacity.<positive integer>` remains the external integration
contract, now measured in logical bytes.

## 3. Runtime model

V2 preserves the physical allocation while online. It must not collapse all
contents into totals and repartition the entire network during flush.

Runtime cell:

```js
{
  cellId, networkId,
  capacityUnits, usedUnits, itemCount,
  entries: Map<itemKey, amount>,
  revision, persistedRevision, dirty, activeGeneration,
}
```

Runtime network:

```js
{
  networkId, state,
  cells: Map<cellId, RuntimeCell>,
  totals: Map<itemKey, amount>,
  locationsByKey: Map<itemKey, Set<cellId>>,
  capacityUnits, usedUnits, itemCount, typeCount,
  revision, persistedRevision, metadataDirty, flushState,
  terminalDisplays, sortCaches, center, topologyRevision,
}
```

`totals` serves terminals/crafting/buffers; `locationsByKey` finds physical
entries without scanning every cell.

Runtime invariants after every mutation:

```text
totals[key] = sum(cell.entries[key])
itemCount = sum(totals.values())
typeCount = totals.size
cell.usedUnits = sum(cost(cell entries))
network.usedUnits = sum(cell.usedUnits)
```

Persisted summary fields are diagnostic only and are recalculated on load.

## 4. Allocation and mutation

### 4.1 Insert

1. Normalize the request and classify the key.
2. Reject invalid/UI items, invalid opaque amounts, unsafe integers, and
   networks not accepting mutations.
3. Plan against cells already containing the key first, ordered by greatest
   insertable amount and stable `cellId`.
4. Then use best-fit cells without the key: the smallest free-unit value that
   accepts at least one item.
5. Calculate exact per-cell deltas and allow partial insertion.
6. Apply the complete plan as one in-memory transaction.
7. Update entries, aggregates, location index, revisions, and terminal events.
8. Mark only changed cells dirty.

Opaque insertion reserves 64 B in a target cell before storing the native
ItemStack. Vault failure cancels the reservation; runtime failure discards the
new vault slot.

### 4.2 Extract

Use `locationsByKey` and prefer the cell containing the smallest amount. Emptying
an entry first reclaims overhead and reduces fragmentation. Apply the plan
atomically, remove zero entries from all indexes, and dirty only changed cells.

Opaque extraction takes one vault item first. A missing vault item does not
decrement logical storage and schedules vault recovery.

### 4.3 Batch operations

Crafting and rollback paths use:

```js
planMutation(networkId, operations)
commitMutation(plan)
```

The planner simulates all extracts/inserts against one temporary allocation.
Commit applies all runtime changes or none. Vault/external ItemStack side effects
use reservation and compensation.

### 4.4 Flush never repartitions

Routine flush serializes current cell allocations. An optional manual optimizer
may later consolidate entries through a planned multi-cell transaction, but is
not part of persistence.

## 5. Paged persistence

### 5.1 Budgets

```js
PAGE_TARGET_BYTES = 24_000;
PAGE_HARD_LIMIT_BYTES = 28_000;
PAGES_WRITTEN_PER_TICK = 2;
PAGES_READ_PER_TICK = 4;
```

Every string is measured as UTF-8 before writing. Chunking preserves surrogate
pairs. No string at or above the hard limit reaches `setDynamicProperty`.

### 5.2 A/B generation layout

```text
<base>:h                         head: "a" or "b"
<base>:ma                        manifest A
<base>:mb                        manifest B
<base>:g<generation>:p<page>     immutable page
```

Canonical world bases:

```text
ucds:v2:c:<cellId>       cell
ucds:v2:n:<networkId>    network
ucds:v2:d:<definitionId> item definition
ucds:v2:tx:<txId>        transaction intent
```

Topology uses the same protocol on the Storage Center entity with base
`ucds:v2:t`.

### 5.3 Payload and manifest

The canonical JSON document is serialized once and split into raw string
fragments. Ordered concatenation recreates it exactly, including unusually large
single definitions. Cell entries use deterministic sorted tuples:

```js
[[itemKey, amount], [itemKey, amount]]
```

Manifest:

```js
{
  schema: 2,
  id: 42,
  revision: 81,
  generation: 7,
  pageCount: 3,
  byteLength: 58124,
  pageHashes: ["...", "...", "..."],
  documentHash: "...",
  metadata: {}
}
```

Hashes are deterministic corruption detectors, represented as two 32-bit
hexadecimal parts; they are not security primitives.

### 5.4 Commit protocol

1. Snapshot record and runtime revision.
2. Canonically serialize, split, and validate all pages in memory.
3. Allocate a new generation.
4. Write immutable pages incrementally.
5. Read back and verify page hashes.
6. Write and verify the inactive manifest slot.
7. Flip the one-character head last.
8. Retain both manifest generations as fallback.
9. Low-priority GC removes generations referenced by neither valid manifest.

A crash before the head flip leaves the prior generation active. If head or its
manifest is corrupt, readers validate both slots and choose the highest valid
revision. A failed save never deletes previous valid data.

Online mutation may continue during a snapshot. After commit, clear `dirty`
only when `runtime.revision === snapshot.revision`; otherwise retain it for the
next flush. Only one flush per record runs at once, and later requests coalesce.

## 6. Persistent schemas

### 6.1 Cell

Manifest metadata:

```js
{
  cellId,
  ownerNetworkId: 0,
  capacityUnits,
  usedUnits,
  itemCount,
  typeCount,
  contentRevision,
}
```

Pages contain entry tuples only. Ownership changes commit a small manifest
pointing to the same content generation; releasing a cell never rewrites item
pages.

### 6.2 Network

```js
{
  networkId, state, center, topologyRevision, cellIds,
  capacityUnits, usedUnits, itemCount, typeCount, revision,
}
```

Cells remain the durable source of amounts. `changes` becomes runtime-only.
Drive/terminal positions come from topology instead of being duplicated.

### 6.3 Indexes

Next-id properties remain numeric. Indexes use bounded 256-id buckets:

```text
ucds:v2:ci:<floor(cellId / 256)>
ucds:v2:ni:<floor(networkId / 256)>
```

Startup derives the highest possible bucket from the corresponding next-id
counter. Empty buckets may be removed.

### 6.4 Item definitions and opaque items

Defined items use the same paged A/B protocol. Existing canonical hashing and
collision suffixes remain. A new item key cannot enter runtime until its required
definition is durable. Opaque native ItemStacks remain in vault entities; pages
store only reference keys.

### 6.5 Topology

The full topology no longer occupies one `ucds:network_topology` string. It is a
paged entity document with machine counts, energy cost, dimension, revision, and
machine positions.

Scanning becomes incremental. On topology mutation:

1. Freeze new I/O for the center.
2. Safely close/flush the old network.
3. Incrementally rescan connected blocks.
4. Commit topology pages.
5. Validate exactly one center, drives, and discovered cells.
6. Activate a new runtime network.

## 7. Persistence coordinator

One coordinator owns incremental work, budgets, and fairness. Proposed modules:

```text
storage/persistence/paged_store.js
storage/persistence/index_store.js
storage/persistence/transactions.js
storage/persistence/coordinator.js
```

Priority:

1. Item-definition commit blocking an operation.
2. Network close/recovery.
3. Dirty-cell auto-flush.
4. Network/topology metadata.
5. Old generation/orphan cleanup.

It round-robins networks. The current 1,200-tick dirty age and 100-tick scan
interval can remain initially, but they queue jobs instead of synchronously
rewriting a network.

Orderly shutdown performs urgent synchronous writes for remaining dirty cells.
This is bounded by changes since the last auto-flush rather than total network
size. Drive lore sync is skipped.

## 8. Lifecycle and recovery

States:

```text
loading -> online -> closing -> deleted
                  -> faulted
loading -> over_capacity -> online when usage becomes valid
```

Activation loads topology/cells incrementally, validates uniqueness/totals,
prevalidates every ownership claim, rolls claims back if creation fails, then
commits `online` and links machines. Operations are rejected until startup
recovery is complete and the network is online.

Online flush snapshots only dirty cells and dirty metadata. Runtime stays online.

Close/power off:

1. Set `closing` and reject new mutations.
2. Drain/cancel older snapshots safely.
3. Commit every dirty cell.
4. Persist network as `closing`.
5. Release owners idempotently; any failed release keeps the network record.
6. Remove network index/record, runtime caches, and machine links.

Cells are never released after a failed content flush.

Recovery is idempotent and state based:

- Same-center valid online record: resume it.
- `loading`: finish valid claims or roll them back.
- `closing`: finish commit and release.
- Owner references missing network: validate cell data, then clear only owner.
- Newest corrupt generation: use the other valid manifest and mark degraded.
- No valid generation: mark faulted, retain all properties, never create an
  empty replacement.

Failure UI uses last valid totals and never shows `0 / 0` merely because no live
snapshot was returned.

## 9. Multi-record transactions

Offline transfers use a small paged intent containing the involved cell ids and
both complete post-states. The intent is durable before either cell changes.
Recovery replays destination and source idempotently, then removes the intent
and its bounded index entry. Runtime storage stays locked until startup recovery
finishes; an unreadable intent is retained and keeps storage locked.

Network creation prevalidates all cells and records their previous owners so a
runtime failure can roll claims back. Release is idempotent and the network
record is not deleted unless every cell was released.

## 10. Transfer Station

Speed remains physical items per operation. Capacity uses logical bytes.

1. Reject cells owned by online/closing networks.
2. Prefer keys already in destination.
3. Charge exact overhead for new destination keys.
4. Move no more than speed limit or exact destination fit.
5. Persist a two-cell intent with both post-states.
6. Commit destination and source; startup recovery can repeat either write.
7. Refresh both cell items after commit.

Source units released and destination units consumed need not be equal.

## 11. UI and API

Snapshots expose explicit fields:

```js
{
  itemCount, typeCount,
  usedUnits, capacityUnits, freeUnits, overCapacityUnits,
  cells, online, state, dirty, revision,
}
```

Temporary `used`, `capacity`, and `free` aliases may map to logical bytes during migration,
but all internal callers must move to explicit fields before release.

Recommended display:

```text
Storage Network: Online
Stored: 935k Items
Types: 417 Item Types
Storage: 14.5 KB / 16 KB (90.3%)
Cells: 16
Drives: 1
Energy Usage: 40 DE/t
```

Cell lore uses the same Stored, Types, and Storage lines without the network,
cell, drive, or energy lines. Durability follows
`usedUnits / capacityUnits`. Terminal slots continue to show item amounts.

Sort results are cached per relevant revision. Type add/remove invalidates key
and page caches; amount changes update visible slots and invalidate count order
only when a full render is needed.

Mutation APIs return stable results:

```js
{
  ok, requested, changed, remaining, itemKey, unitDelta, reason,
}
```

Expected reasons include `network_offline`, `network_busy`, `no_capacity`,
`invalid_item`, `vault_missing`, and `over_capacity`.

## 12. V1 migration

Migration is lazy, incremental, and non-destructive:

1. Prefer valid V2.
2. Otherwise read V1 `ucds:cell:<id>`.
3. Normalize entries without trusting V1 `used`.
4. Calculate V2 units/item/type totals.
5. Commit and verify a V2 generation.
6. Keep V1 until referencing networks migrate and a later GC pass confirms V2.

Network records/indexes migrate through the startup coordinator. Migration
progress is persistent and resumable.

If recalculated V2 usage exceeds capacity:

- Preserve every entry.
- Mark cell/network over capacity.
- Allow extraction and mutations with unit delta <= 0.
- Reject mutations increasing units.
- Return to normal automatically once usage fits.

Migration never deletes items, clamps amounts, or silently drops unreadable
entries.

## 13. Errors, diagnostics, and GC

Critical persistence paths must not use empty catches. Stable error codes include:

```text
page_too_large, page_write_failed, page_hash_mismatch,
manifest_invalid, no_valid_generation, ownership_conflict,
over_capacity, vault_missing, definition_missing, unsafe_integer
```

Player status is short/localized. Logs contain record kind/id, revision,
generation, page, bytes, state, and cause.

Debug tools expose network/cell totals, units, dirty/persisted revisions,
manifests/pages/bytes, pending jobs/transactions, read-only integrity checks,
explicit recovery retry, and orphan GC.

After a successful head flip, GC removes only the superseded generation displaced
from the inactive manifest slot. The active generation and the immediately
previous valid fallback are retained. Unknown/corrupt data is retained for
diagnosis.

## 14. Performance requirements

- Online operations touch only cells used by their allocation plan.
- No normal operation serializes or writes persistent data.
- Flush never scans/rewrites clean cells.
- Normal persistence initially writes at most two 24-KB pages per tick.
- Load/recovery/topology jobs yield by configured work budget.
- Online mutation continues during snapshot flush.
- Closing/recovery/topology mutation freezes mutations for correctness.
- Multiple networks receive fair coordinator time.
- Terminal full sorting does not occur every tick.

Fragmentation creates more persistence calls but bounds and spreads them. Once a
network is loaded, normal gameplay does not read its pages.

## 15. Proposed code boundaries

```text
storage/storage_cost.js              pure cost/delta/invariant helpers
storage/persistence/paged_store.js   chunking, hashes, manifests, generations
storage/persistence/cell_transactions.js  two-cell intents and recovery
storage/cell_store.js                V2 cells and legacy migration
storage/network_runtime.js           allocation, aggregates, mutation plans
storage/item_registry.js             paged definitions/durability barrier
storage/network_topology.js           incremental scan/paged entity topology
storage/opaque_vault.js              native vault plus reservations
```

## 16. Testing and acceptance

Pure cost, allocation, serializer, manifest, transaction, and migration logic
must run without a Minecraft world.

Required coverage:

- Cost boundaries 0/1/8/9 and large safe values.
- New/existing type insertion, splits, partial fit, and overhead-releasing remove.
- Simple/defined/opaque behavior.
- Randomized runtime invariant tests.
- UTF-8 paging including accents, CJK, and surrogate pairs.
- Failure injection before/after every commit step.
- A/B fallback for corrupt head, manifest, or page.
- Mutation during a snapshot.
- Interrupted transfer and ownership transactions at every phase.
- Normal and over-capacity V1 migration.
- Missing definitions/vault pages without deletion.
- Large ultimate cells and multi-drive networks.
- Index bucket boundary 255/256.
- Orderly shutdown with queued dirtiness.

Release acceptance:

- No dynamic-property string reaches 28,000 UTF-8 bytes.
- Item amounts survive flush/reload/migration unchanged.
- Failed flush leaves a readable previous generation.
- Faulted non-empty data is never replaced with empty data.
- Online networks remain usable during auto-flush.
- Power off never releases cells before accepted contents are durable.
- Third-party capacity tags continue working as logical bytes.

## 17. Implementation sequence

1. Pure cost/invariant helpers and tests.
2. Paged store, A/B manifests, hashing, and failure injection.
3. Bucket indexes and V2 cell store with legacy fallback.
4. Per-cell runtime allocation and explicit snapshot metrics.
5. Coordinator and dirty-cell incremental flush.
6. Lifecycle states, ownership transactions, and recovery.
7. Paged item definitions and topology.
8. Vault reservations and batch mutations.
9. Transactional Transfer Station.
10. Center/terminal/buffer/crafting/lore/debug/translation updates.
11. Lazy migration and over-capacity mode.
12. Large soak/failure tests, then legacy write-path removal.

Legacy deletion is a final cleanup step, never part of the first successful
migration.

## 18. Fixed decisions

- One logical-byte capacity number; no separate type limit.
- Existing capacity numbers remain.
- Default cost is 8 B per simple type plus 1 B per eight items; defined types
  cost 16 B overhead and opaque items cost 64 B.
- Type overhead is per physical cell.
- Runtime retains physical allocation plus aggregate indexes.
- Routine flush never repartitions.
- Persistence is paged, immutable by generation, A/B manifested, verified, and
  incremental.
- Online operations continue during snapshot flush.
- Close/recovery/topology changes freeze mutations.
- Over-capacity migration preserves everything and permits withdrawal.
- Opaque items remain native vault ItemStacks.
- Transfer speed remains item-count based.
