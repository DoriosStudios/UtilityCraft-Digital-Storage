# Digital Storage runtime

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

### Cell Record

Stored at:

```txt
ucds:cell:<cellId>
```

Shape:

```js
{
  version: 1,
  networkId: 1,
  capacity: 65536,
  used: 6400,
  items: {
    "minecraft:diamond": 64,
    "ucds:item:abc123def456": 1
  }
}
```

Cells are the durable source of item amounts. Runtime data is rebuilt from the
cells listed in a network record.

### Network Record

Stored at:

```txt
ucds:network:<networkId>
```

Shape:

```js
{
  version: 1,
  online: false,
  center: "overworld|[0,64,0]",
  centers: [],
  drives: [],
  terminals: [],
  cells: [1, 2, 3],
  used: 6400,
  capacity: 65536,
  changeSeq: 12,
  changes: []
}
```

The network record is ownership/topology metadata. It tells the runtime which
cell records belong to this network.

### Item Definitions

Simple stackable items use their `typeId` directly:

```txt
minecraft:stone
```

Items with extra identity use an item definition:

```txt
ucds:item:<definitionId>
ucds:itemdef:<definitionId>
```

The definition stores the canonical item data needed to recreate the stack.
Definitions are written immediately when a new special item is first stored,
because losing a definition would make the item unrecoverable.

## Runtime Lifecycle

1. `world.afterEvents.worldLoad`
   - Reads saved network ids.
   - Reads each network's cell records.
   - Builds one runtime per network id through `system.runJob`.
   - The job yields every few network/cell records so startup work is spread
     across multiple ticks.

2. Network online use
   - `addItem` and `removeItem` only mutate runtime maps.
   - No cell DP writes are performed per item operation.

3. `flushNetwork`
   - Repartitions the runtime totals across the network cells by capacity.
   - Writes each `ucds:cell:<cellId>`.
   - Writes `ucds:network:<networkId>`.

4. `powerOffNetwork`
   - Flushes it.
   - Releases `networkId` from each attached cell.
   - Deletes `ucds:network:<networkId>` and removes it from the network index.
   - Deletes it from `runtimeNetworks`.
   - Cell records keep their capacity, used count, and items.
   - The next online activation must create a fresh network from the current cells/topology.

5. `system.beforeEvents.shutdown`
   - Flushes dirty runtimes.

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
