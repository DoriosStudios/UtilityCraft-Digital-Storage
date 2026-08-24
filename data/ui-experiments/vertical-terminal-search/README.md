# Vertical Terminal Search Experiment

This directory preserves a working proof of concept for compact terminal search results in Minecraft Bedrock UI.

## Status

- Vertical result compaction was confirmed in Minecraft.
- The direct-parent collection host fix was confirmed after Minecraft reported `Unknown property [collection_index]`.
- The archived snapshot includes the latest empty-query visibility correction, but that exact final expression was not retested in Minecraft before the experiment was archived.
- These files are reference copies only. They are not loaded by the active resource pack.

## Files

- `terminal_core.vertical-search.experimental.json`: the experimental terminal layout and search binding.
- `count_label_grid.vertical-search.experimental.json`: hides fixed-position amount labels while a search is active.

## How it works

The original terminal uses 162 fixed-position item slots. Its search field does not rearrange the collection; it places an overlay over slots that do not match the query.

This experiment replaces that fixed slot layout with one horizontal stack containing nine vertical stack columns. Each column owns 18 collection hosts. When a child slot becomes invisible, its vertical stack removes that slot from layout and the remaining matches move upward.

The slots are assigned round-robin across the columns with collection indices 4 through 165. This keeps the nine-column terminal shape while permitting vertical compaction.

## Critical Bedrock UI rule

`collection_index` must be declared on a control whose direct parent is a `collection_panel`. Putting an indexed slot directly under a `stack_panel` causes this Minecraft UI error:

    Unknown property [collection_index]

The experiment therefore uses `grid_item_host`, a small `collection_panel` wrapper, around every indexed slot. The stack columns contain these hosts, and each host contains the actual slot as its direct child.

The wrapper pattern is conceptually:

    "slot_host_000@ds.grid_item_host": {
      "$slot_index": 4
    }

and `ds.grid_item_host` contains:

    "slot@ds.grid_item_template": {
      "collection_index": "$slot_index"
    }

Do not remove that wrapper when restoring the experiment.

## Search visibility

Each slot reads the search box text and its item hover text. The archived visibility expression is:

    (not (((#hover_text - #edit_box_input) = #hover_text) and not (#edit_box_input = '')))

Its intent is:

- Empty query: every populated slot is visible.
- Non-empty query: only matching slots are visible.

The expression is the inverse of the original overlay condition. A property bag initializes both values to empty strings so the bindings have defaults. Because the final empty-query correction was not retested before archiving, verify this behavior again in Minecraft before promoting these files.

The existing amount labels remain a separate fixed nine-by-eighteen text grid. They cannot follow compacted item slots, so the experimental count-label file hides all amount labels while a search query is active. Empty search restores the normal count grid.

## Restoring the experiment

1. Back up any newer work in the active UI files.
2. Copy `terminal_core.vertical-search.experimental.json` to `RP/ui/core/terminal_core.json`.
3. Copy `count_label_grid.vertical-search.experimental.json` to `RP/ui/core/count_label_grid.json`.
4. Add an appropriate user-visible changelog entry for the active upcoming version.
5. Run `npm run check`, `npm run verify:imports`, and `npm run bundle`.
6. Test the behavior in Minecraft Bedrock.

## Minecraft test checklist

1. Open a Digital Storage terminal with items occupying several rows.
2. Leave the search field empty. Confirm that all items and amount labels are visible.
3. Type a query matching items in different original rows and columns.
4. Confirm that matching items compact upward independently in each of the nine columns.
5. Confirm that nonmatching items disappear and that amount labels are hidden during search.
6. Clear the query completely. Confirm that all items and amount labels return.
7. Change pages and repeat the test. Search affects only the active 162-slot page.
8. Check the Minecraft content log for binding or `collection_index` errors.

## Known limitations

- Search filters only the currently loaded page; it does not query the complete storage inventory.
- Results compact vertically within their original columns, not into one global row-major list.
- Counts are hidden during search because the current count labels are not part of the item collection controls.
- This is a preserved experiment, not production UI.
