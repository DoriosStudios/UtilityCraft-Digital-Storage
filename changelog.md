# UtilityCraft: Digital Storage v1.0.0

## ADDED
- Added tag-based Storage Cell registration so other add-ons can provide compatible cells without script component dependencies.

## COMPATIBILITY
- Registered all Digital Storage recipes tagged `utilitycraft_workbench` with UtilityCraft's Crafter through the DoriosLib registry.

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
