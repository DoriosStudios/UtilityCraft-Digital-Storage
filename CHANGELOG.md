# UtilityCraft: Digital Storage v1.0.2

## ADDED
- Added weighted logical storage bytes: new simple item types cost 8 B plus one byte per eight items, defined custom types cost 16 B plus payload, and opaque non-stackable items cost 64 B.
- Added paged, checksummed dynamic-property generations with A/B manifests and automatic fallback to the previous valid generation.
- Added recoverable cell-to-cell transaction intents for the Storage Transfer Station.
- Added explicit item count, type count, used bytes, free bytes and over-capacity metrics.

## CHANGED
- Storage Cell capacity numbers now represent logical bytes instead of a raw one-item-per-capacity limit; existing tier capacities remain unchanged.
- Online networks now preserve physical per-cell allocations and flush only dirty cells instead of repartitioning and rewriting the complete network.
- Large cell records, network records, item definitions and Storage Center topologies are fragmented into bounded pages.
- Auto-flush, topology scans, topology writes, startup migration and transaction recovery now run incrementally across ticks.
- Topology rebuilds now deduplicate connected components so one cable change does not rescan the same large network from multiple adjacent blocks.
- Physical network edits now debounce nearby changes, rescan the affected components and rebuild the runtime only after the topology snapshot is committed.
- Successful paged commits retain the active and fallback generations while collecting only the older unreferenced pages.
- Storage Center and Storage Cell displays now distinguish stored items, item types and logical-byte usage in a shorter format.
- Storage percentage lore now escapes Minecraft's percent formatting correctly, and Storage Center detail lines retain their visual indentation.
- Storage Transfer Station capacity checks now use exact logical-byte deltas while transfer speed remains item-count based.

## FIXED
- Fixed large networks failing recovery when a serialized cell, network or topology exceeded the Dynamic Property string limit.
- Fixed failed recovery displays replacing useful totals with a misleading `0 / 0` snapshot.
- Fixed routine network flushes concentrating many item types into the earliest high-capacity cell.
- Fixed failed network creation or shutdown leaving cells partially claimed or releasing a network record before every cell was safely detached.
- Fixed machines mutating storage while startup transaction recovery was still in progress; blocking recovery faults are now shown on the Storage Center.
- Fixed disconnected Drives, terminals and Import/Export Buffers retaining an obsolete network link after cables or machines changed the physical topology.

## COMPATIBILITY
- Existing V1 cell and network records are read and migrated lazily to V2 without deleting or clamping stored items.
- Cells that exceed the new weighted capacity preserve all contents and allow withdrawals or zero-cost additions until usage returns within capacity.
- Existing `utilitycraft:ds.capacity.<number>` third-party cell tags remain supported; the number is now interpreted as logical bytes.

---

# UtilityCraft: Digital Storage v1.0.1

## ADDED
- Added lightweight native ItemStack vault pages for items whose maximum stack size is one, preserving add-on dynamic properties, bundle contents, shulker contents, durability, enchantments, and other opaque data.
- Added two rotating global entity-only vault backups, saved every five minutes and used only when a required page is missing.
- Added automatic recovery of missing vault pages at a temporary location without moving live vault entities or pausing unrelated storage operations.
- Added player feedback when an item's vault page is temporarily unavailable; the visual terminal item is removed while the network count remains unchanged.
- Added the Wireless Panel to the Wireless creative inventory group; it links to an active Overworld Storage Center and opens a personal Storage Terminal while held.

## CHANGED
- New stackable-item keys now use only the item type, custom name, and exact lore; quantities continue using the existing cell and network system.
- Export Buffers and Crafting Terminal recipes continue using normal logical keys; opaque vault references remain separate.
- Export Buffer filters now control their three slots directly below them, merge compatible partial stacks, preserve duplicate filters as separate columns, and skip blocked columns when processing the next available filter.

## COMPATIBILITY
- Existing plain item keys and full ucds:item definitions remain readable and extractable. Reinserted legacy items use the new stackable or opaque storage path.

---

# UtilityCraft: Digital Storage v1.0.0

## ADDED
- Added tag-based Storage Cell registration so other add-ons can provide compatible cells without script component dependencies.

## COMPATIBILITY
- Registered all Digital Storage recipes tagged `utilitycraft_workbench` with UtilityCraft's Crafter through the DoriosLib registry.
- Added Vibrant Visuals support to the resource pack.

## FIXES
- Fixed Storage Centers failing to initialize when a Storage Cell retained ownership from a previous network.
- Storage Centers now show the specific reason when network initialization or recovery fails.
- Fixed Item Conduits visually connecting to Storage Cell Drives, whose inventory is not available to automation.

---

# UtilityCraft: Digital Storage v1.0.0.07 Beta

This update completely reworks Digital Storage with faster interfaces, improved storage networks, safer item handling, rebalanced recipes and new ways to manage Storage Cells.

## HIGHLIGHTS
- Completely reworked the Digital Storage network and terminal systems.
- Added the Storage Transfer Station.
- Added Cell Casings and reworked Storage Cell crafting.
- Rebalanced machine, component and storage progression recipes.
- Improved performance and fixed multiple causes of item loss.

---

## STORAGE NETWORK
- Reworked how Digital Storage networks are created, powered and updated.
- Added support for multiple independent storage networks in the same world.
- Storage Centers now automatically connect Cell Drives, terminals and Import/Export Buffers.
- Network energy consumption now depends on the connected machines.
- Networks safely turn off when their structure changes, a Cell is replaced or the Storage Center runs out of energy.
- Improved Network Cable connections and visuals when the network changes.
- Storage Centers now display network status, stored items, capacity, usage, Cell count, Drive count and energy cost.
- Cell Drives now support up to 16 Storage Cells and combine their capacities.

## TERMINALS
### Storage Terminal
- Completely reworked the interface to load and update stored items faster.
- Displays up to 162 item types per page with compact amount labels.
- Added improved page controls and a manual reload button.
- Added four dedicated slots for inserting items into the network.
- Improved handling of items with custom names, lore, durability and enchantments.

### Crafting Terminal
- Completely reworked the Crafting Terminal interface and functionality.
- Added a functional 3x3 crafting grid that can use materials from the connected network.
- Added crafting quantities of 1, 2, 4, 8, 16 and 64.
- Crafted items can be sent to the player inventory or returned to the storage network.
- Added support for recipes with multiple outputs and leftover container items.

## AUTOMATION
### Import Buffer
- Reworked the Import Buffer with 18 input slots.
- Imports one occupied stack every 10 ticks, plus one additional stack per Speed Upgrade level.

### Export Buffer
- Reworked the Export Buffer with 9 filter slots and 27 output slots.
- Exports one matching stack every 10 ticks, plus one additional stack per Speed Upgrade level.

### Storage Transfer Station
- Added a new machine for transferring stored items directly between two Storage Cells.
- Transfers up to 500 items every 10 ticks, plus 500 per Speed Upgrade level.
- The Transfer Station respects the destination Cell capacity and cannot modify Cells in an active network.

## BLOCKS AND ITEMS
- Added the Cell Casing, used together with Storage Parts to craft Storage Cells.
- Added the Block of Fluxite and updated the Fluxite texture.
- Migrated Silicon and the Block of Silicon to the base UtilityCraft addon.
- Updated Digital Storage machines with new full-block models and front textures.
- Storage Cell capacities are now:
  - Storage Cell: 1,024 items.
  - Basic Storage Cell: 4,096 items.
  - Advanced Storage Cell: 16,384 items.
  - Expert Storage Cell: 65,536 items.
  - Ultimate Storage Cell: 409,600 items.

## RECIPES
- Rebalanced recipes for Digital Storage machines, Storage Parts and Storage Cells.
- Storage Cells are now crafted using a Cell Casing and the matching Storage Part.
- Reworked the Storage Core, Storage Center, Cell Drive, terminal and colored Import/Export Buffer recipes.
- The Crafting Terminal now uses a Crafter in its recipe.
- Added recipes for the Storage Transfer Station and Block of Fluxite.
- Updated Fluxite production and added its recipe to the Infuser Recipe Book.
- Removed the Blueprint Terminal recipe while its rework remains unavailable.

## UI/UX
- Reworked the Storage Center, Cell Drive, terminal and buffer interfaces, including dedicated screens for the Import Buffer and Storage Transfer Station.
- Added information panels and improved buttons, scrolling, item counts and capacity displays.
- Interfaces now update only when needed, making terminals faster and more responsive.

## FIXES
- Fixed item loss when inserting, extracting or swapping items in terminals.
- Fixed Storage Cells becoming stuck inside Cell Drives.
- Fixed Digital Storage machines not dropping their stored items when broken.
- Fixed internal interface items being moved or taken from terminal slots.
