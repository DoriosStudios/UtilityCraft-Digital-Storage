# Digital Storage runtime

The Storage V2 rework is specified in `STORAGE_V2_DESIGN.md`.

`storage` is the canonical storage backend for Digital Storage. It is intentionally
separate from terminals and block ticking: terminals should behave as UI views
over this API, not as database owners.

## Goals

- Keep storage operations fast by using runtime `Map` objects while a network is online.
- Persist durable state in world dynamic properties only at explicit save boundaries.
- Support multiple independent networks in the same world.
- Preserve special item identity: lore, name tag, durability damage, enchantments,
  dynamic properties, `canPlaceOn`, and `canDestroy`.
- Make the database testable before terminal UI is rebuilt.

## Module Layout

- `cell_store.js`
  Owns world dynamic property records for storage cells, networks, and indexes.

- `item_registry.js`
  Converts real `ItemStack` objects into stable item keys and stores item definitions
  for non-simple items.

- `network_runtime.js`
  Owns in-memory network state and exposes operations such as add, remove, flush,
  reload, and power off.

- `network_debug.js`
  Exposes temporary `scriptevent` commands for testing without a terminal.

- `index.js`
  Queues an incremental load job on `world.afterEvents.worldLoad` and flushes
  dirty runtimes on `system.beforeEvents.shutdown`.

## Persistent Data

V2 records use immutable UTF-8 pages, two alternating manifests, hashes, and a
one-character head written last:

```txt
<base>:h
<base>:ma
<base>:mb
<base>:g<generation>:p<page>
```

The canonical bases are `ucds:v2:c:<cellId>` for cells,
`ucds:v2:n:<networkId>` for network metadata, `ucds:v2:d:<definitionId>`
for special-item definitions, and `ucds:v2:t` on a Storage Center for its
topology. Pages target 24 KB and are verified before a manifest becomes active.
The prior generation remains readable if a write is interrupted or the newest
generation is damaged.

Cell payloads contain sorted `[itemKey, amount]` tuples. Their manifest metadata
contains ownership, capacity in logical bytes, item/type totals, and revision.
Cells—not aggregate network totals—remain the durable source of item amounts.
Network and cell indexes are split into fixed 256-id buckets so the indexes
cannot grow into one oversized dynamic property.

Simple stackable items continue to use their `typeId` directly. Items with
additional identity use `ucds:item:<definitionId>`; opaque items that cannot be
serialized safely use `ucds:vault:<cellId>:<slot>` and remain native
`ItemStack` values in the cell entity.

Legacy `ucds:cell:*`, `ucds:network:*`, and `ucds:itemdef:*` records remain
readable. Cells are migrated lazily to V2 without deleting their V1 data first.

## Capacity

Cell capacity tags keep their existing numeric values but now represent logical
storage bytes, not raw item counts or actual serialized bytes. There is no hard
item-type limit.

- Simple type: 8 B overhead plus 1 B per 8 items.
- Defined type: 16 B overhead plus 1 B per 8 items.
- Opaque native item: 64 B.

Type overhead is charged per physical cell. Runtime therefore retains the exact
contents of every cell; a flush serializes that allocation and never repartitions
the whole network.

## Runtime Lifecycle

1. `world.afterEvents.worldLoad`
   - Recovers pending two-cell transfer intents first.
   - Loads and lazily migrates saved records through `system.runJob`.
   - Storage Centers remain in `Loading Storage` until recovery is complete.

2. Network online use
   - `addItem` allocates into cells already containing the key first, then the
     smallest suitable empty cell.
   - `removeItem` prefers cells that release type overhead.
   - Operations update in-memory cell maps and aggregate indexes.

3. `flushNetwork`
   - Snapshots and writes only dirty cells through an incremental job.
   - Runtime stays online while pages are written.
   - A cell remains dirty when it changes after the snapshot was taken.

4. `powerOffNetwork`
   - Moves the runtime to `closing` and rejects new mutations.
   - Cancels an older background snapshot and flushes current dirty cells.
   - Releases `networkId` from each attached cell.
   - Deletes the network record and removes it from the network index.
   - Deletes it from `runtimeNetworks`.
   - A failed content flush never releases ownership.

5. `system.beforeEvents.shutdown`
   - Cancels background jobs and synchronously flushes dirty runtimes.

The Transfer Station works on offline cells only. It calculates exact byte deltas,
writes a recoverable intent containing both post-states, then commits source and
destination. Startup recovery repeats an interrupted commit idempotently.

## Debug Commands

Commands are temporary and use `scriptevent`.

```mcfunction
/scriptevent ucds:create_network_from_drives {"dim":"overworld","drives":[{"x":10,"y":64,"z":10},{"x":12,"y":64,"z":10}]}
/scriptevent ucds:print_network {"networkId":1}
/scriptevent ucds:add_item {"networkId":1,"id":"minecraft:diamond","amount":64}
/scriptevent ucds:remove_item {"networkId":1,"id":"minecraft:diamond","amount":16}
/scriptevent ucds:add_from_chest {"networkId":1,"dim":"overworld","x":10,"y":64,"z":10,"slot":0}
/scriptevent ucds:remove_to_chest {"networkId":1,"itemKey":"minecraft:diamond","amount":32,"dim":"overworld","x":10,"y":64,"z":10}
/scriptevent ucds:flush_network {"networkId":1}
/scriptevent ucds:reload_network {"networkId":1}
/scriptevent ucds:power_off_network {"networkId":1}
/scriptevent ucds:power_off_all_networks
```

Recommended DB test flow:

```txt
create_network_from_drives
add_from_chest / add_item
print_network
flush_network
reload_network
print_network
power_off_network
power_off_all_networks
```

## Design Notes

- A cell should belong to one network at a time through `networkId`.
- A powered-off network no longer exists as a network record. Its cells are
  released so they can be moved or attached to a different network without
  ownership conflicts.
- Runtime maps are the active source of truth only while the network is online.
- Cell records are the durable source of truth after a flush or shutdown.
- UI code should not read/write world dynamic properties directly. It should call
  `network_runtime.js` APIs and render snapshots.
