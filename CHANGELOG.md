This update expands wireless storage and crafting, introduces byte-based cell capacity, and improves saving and recovery for large networks.

> [!WARNING]
> Requires UtilityCraft 3.6.1 or newer. Existing storage records migrate automatically. Cell capacities now use logical bytes; cells that exceed their new capacity retain their contents and allow withdrawals until space is available again.

## HIGHLIGHTS

- Storage Cells now use byte-based capacity with clearer usage information.
- Storage networks save incrementally and can recover a previous valid generation.
- Wireless access gains configurable range and a cross-dimensional upgrade.
- Wireless Crafting Panel adds crafting alongside remote storage access.

## BLOCKS

- **Crafting Terminal**
    - Recipes can combine ingredients from the network and the crafting grid.
- **Storage Cells**
    - Capacity values now represent logical bytes instead of individual item counts.
    - Simple item types cost 8 B plus 1 B per eight items; defined custom types cost 16 B plus 1 B per eight items; opaque non-stackable items cost 64 B each.
    - Existing cells retain their contents during migration, including cells over capacity.
- **Storage Center**
    - Added a dedicated wireless range upgrade slot.
    - Wireless access starts at 64 blocks and gains 128 blocks per Range Upgrade, up to eight upgrades and a total of 1,088 blocks.
    - Networks preserve item allocations across cells and save only changed cells.
- **Storage Transfer Station**
    - Capacity checks now account for the actual byte cost of transferred items.
    - Interrupted cell-to-cell transfers can be recovered.

## ITEMS

- Added **Dimensional Range Upgrade**.
    - Allows Wireless Panels to access an online network across dimensions without a distance limit.
- Added **Wireless Crafting Panel**.
    - Combines remote storage access with the Crafting Terminal grid and controls.
    - Returns remaining crafting-grid items when closed.
- **Wireless Panels**
    - Interacting with the linked Storage Center unlinks either panel variant; interacting again links it back.
    - Active panels remain locked in the selected hotbar slot while in use.
    - The creative inventory now lists only unlinked variants.

## RECIPES

- Added UtilityCraft Workbench and Crafter recipes for the Wireless Panel, Wireless Crafting Panel and Dimensional Range Upgrade.

## UI/UX

- Removed addon signatures from internal UI items so machine information panels and interface placeholders no longer display them.

- Storage Center and Storage Cell displays now distinguish item counts, item types and used or free bytes.
- Updated the Storage Transfer Station progress arrow and addon labels.

## BUG FIXES

- Fixed opening placed storage inventories after Minecraft's interaction changes; sneaking selects the block for mining.
- Fixed terminal button presses being restored before their actions could be detected.
- Fixed nearby Wireless Panels resolving another player's helper entity.
- Fixed temporary recipe-validation blocks remaining after a Crafting Terminal closed.
- Fixed disconnected drives, terminals and buffers retaining obsolete network links after cable or machine changes.
- Fixed large storage records exceeding dynamic-property limits and recovery failures displaying misleading empty totals.
- Fixed partial network initialization or shutdown leaving cells incorrectly claimed, and blocked item changes while startup recovery is incomplete.

## TECHNICAL CHANGES

- Added paged storage with checksums and two recoverable generations, including fallback to the previous valid data.
- Distributed saves, network scans, migrations and transaction recovery across ticks, and combined overlapping network rebuilds.

## THIRD-PARTY / INTEGRATION

- Existing storage-cell capacity tags remain supported; their values now represent logical bytes.
