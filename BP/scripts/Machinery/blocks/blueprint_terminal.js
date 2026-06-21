// Imports

import { ItemStack, system } from "@minecraft/server";
import { ButtonManager } from "DoriosCore/index.js";
import { Terminal } from "Machinery/core/terminal.js";
import { getCellData, cellCapacities } from "Machinery/blocks/storage_cell_drive.js";
import { getNetworkIdForBlock, updateNetworkAround } from "Machinery/storage/network_manager.js";
import { readNetworkMeta, readNetworkRecord } from "Machinery/storage/storage_db.js";
import { applyVirtualLore, needsVirtualLoreRewrite } from "Machinery/storage/virtual_item_codec.js";

// Constant

const BURN_SLOT = 227;
const STORAGE_START = 0;
const STORAGE_END = 224;
const NEXT_SLOT = 228;
const PREVIOUS_SLOT = 229;
const QUANTITY_SLOT = 230;
const SORT_SLOT = 231;
const CRAFTING_BLUEPRINT_SLOT = 232;
const CRAFTING_OUTPUT_SLOT = 233;
const CRAFTING_INFO_PANEL_SLOT = 234;
const CRAFT_QTY_SLOT = 235;
const OUTPUT_MODE_SLOT = 236;
const CRAFT_BUTTON_SLOT = 237;
const REMOVE_RECIPE_SLOT = 238;
const STORAGE_SLOTS = 225;
const LORE_DISPLAY = "§r§7- Count: §f";
const MAX_PAGES = 27;
const OUTPUT_BLUEPRINT_ITEM = "utilitycraft:blueprint";
const RESERVED_FILLER_SLOTS = [225, 226];
const CONTROL_SLOTS = [
  PREVIOUS_SLOT,
  NEXT_SLOT,
  QUANTITY_SLOT,
  CRAFT_QTY_SLOT,
  SORT_SLOT,
  OUTPUT_MODE_SLOT,
  CRAFT_BUTTON_SLOT,
  REMOVE_RECIPE_SLOT,
];
const CRAFT_MULTIPLIERS = [1, 2, 4, 8, 16, 64];
const OUTPUT_PREVIEW_LORE = ["§1§1§1§1§1§1§1"];
const RENDER_SETTINGS = {
  machine: {
    rate_speed_base: 0,
  },
  ignoreTick: false,
};
const BUTTON_RELEASE_TICKS = 6;

// Main Work (Functions)

function getEntityBlock(entity) {
  return Terminal.getEntityBlock(entity);
}
function renderBlueprintTerminalNow(entity) {
  try {
    if (!entity || !entity.isValid) return;
    const block = getEntityBlock(entity);
    if (!block) return;
    runCraftingStorageTerminalTick(block, entity, RENDER_SETTINGS);
  } catch (e) {
    console.warn("Blueprint terminal button render skipped.");
  }
}
function scheduleBlueprintTerminalRender(entity) {
  system.runTimeout(() => renderBlueprintTerminalNow(entity), 1);
}
function controlsNeedRender(inv) {
  return Terminal.controlsNeedRender(inv, CONTROL_SLOTS);
}
function getCraftQty(entity) {
  const value = Number(entity.getDynamicProperty("craft_qty") ?? 1);
  return CRAFT_MULTIPLIERS.includes(value) ? value : 1;
}
function getNextCraftQty(currentQty) {
  const index = CRAFT_MULTIPLIERS.indexOf(currentQty);
  return CRAFT_MULTIPLIERS[(index + 1) % CRAFT_MULTIPLIERS.length];
}
function getOutputMode(entity) {
  return entity.getDynamicProperty("output_mode") === "network" ? "network" : "inventory";
}
function renderBlueprintTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort) {
  const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
  prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${pageCount}`;
  inv.setItem(PREVIOUS_SLOT, prevItem);
  const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
  nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${pageCount}`;
  inv.setItem(NEXT_SLOT, nextItem);
  const qtyItem = new ItemStack("utilitycraft:ui_filler", 1);
  qtyItem.nameTag = `§r§fx${currentQty}`;
  inv.setItem(QUANTITY_SLOT, qtyItem);
  const craftQtyItem = new ItemStack("utilitycraft:ui_filler", 1);
  craftQtyItem.nameTag = `§r§fx${currentCraftQty}`;
  inv.setItem(CRAFT_QTY_SLOT, craftQtyItem);
  const sortItem = new ItemStack("utilitycraft:ui_filler", 1);
  sortItem.nameTag = `§r§7- Sort By: §f${currentSort === "name" ? "Name" : "Count"}`;
  inv.setItem(SORT_SLOT, sortItem);
  const modeItem = new ItemStack("utilitycraft:ui_filler", 1);
  modeItem.nameTag = getOutputMode(entity) === "network" ? "§r§fTo Network" : "§r§fTo Inventory";
  inv.setItem(OUTPUT_MODE_SLOT, modeItem);
  const craftItem = new ItemStack("utilitycraft:ui_filler", 1);
  craftItem.nameTag = "§r§fCraft";
  inv.setItem(CRAFT_BUTTON_SLOT, craftItem);
  const clearItem = new ItemStack("utilitycraft:ui_filler", 1);
  clearItem.nameTag = "§r§cClear Blueprint";
  inv.setItem(REMOVE_RECIPE_SLOT, clearItem);
  entity.setDynamicProperty("last_rendered_page", currentPage);
  entity.setDynamicProperty("last_rendered_page_count", pageCount);
  entity.setDynamicProperty("last_rendered_qty", currentQty);
  entity.setDynamicProperty("last_rendered_craft_qty", currentCraftQty);
  entity.setDynamicProperty("last_rendered_sort", currentSort);
  entity.setDynamicProperty("last_rendered_output_mode", getOutputMode(entity));
}
function initializeBlueprintTerminalInventory(entity) {
  const inv = entity.getComponent("minecraft:inventory")?.container;
  if (!inv) return false;

  for (let slot = STORAGE_START; slot <= STORAGE_END; slot++) {
    const item = inv.getItem(slot);
    if (!item || item.typeId === "utilitycraft:storage_filler") {
      inv.setItem(slot, Terminal.createStorageFiller(entity, slot));
    }
  }

  Terminal.repairFillerSlots(inv, RESERVED_FILLER_SLOTS, { entity });
  renderBlueprintTerminalControls(entity, inv, 0, 1, 1, 1, "count");
  return true;
}
function refreshBlueprintTerminalControls(entity) {
  try {
    if (!entity || !entity.isValid) return;
    const inv = entity.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    let currentPage = entity.getDynamicProperty("page") ?? 0;
    const pageCount = getPageCountForEntity(entity);
    currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));
    const currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
    const currentCraftQty = getCraftQty(entity);
    const currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
    renderBlueprintTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);
  } catch (e) {}
}
function canChangePage(entity) {
  return Terminal.canChangePage(entity, Terminal.getPageChangeDelayTicks());
}
function markPageChanged(entity) {
  Terminal.markPageChanged(entity);
}
function isStorageCell(item) {
  if (!item) return false;
  return item.typeId in cellCapacities;
}
function getItemKey(item) {
  return Terminal.getItemKey(item);
}
function createItemFromKey(key, amount) {
  return Terminal.createItemFromKey(key, amount);
}
function getStoredCount(item) {
  return Terminal.getStoredCount(item);
}
function returnToPlayer(block, itemStack) {
  Terminal.returnToPlayer(block, itemStack);
}
function amountToCraftFromNetwork(blueprint, containers, maxCraftAmount) {
  const recipeStr = blueprint.getDynamicProperty("materials");
  if (recipeStr === undefined) return 0;
  try {
    const recipe = JSON.parse(recipeStr);
    if (!Array.isArray(recipe) || recipe.length === 0) return 0;
    let possibleCrafts = maxCraftAmount;
    for (const mat of recipe) {
      const available = countItemsInNetwork(containers, mat.id);
      const craftsForMat = Math.floor(available / mat.amount);
      if (craftsForMat === 0) return 0;
      possibleCrafts = Math.min(possibleCrafts, craftsForMat);
    }
    return possibleCrafts;
  } catch (e) {
    return 0;
  }
}
function amountToCraftFromGrid(blueprint, container, gridSlots, maxCraftAmount) {
  const recipeStr = blueprint.getDynamicProperty("materials");
  if (recipeStr === undefined) return 0;
  try {
    const recipe = JSON.parse(recipeStr);
    if (!Array.isArray(recipe) || recipe.length === 0) return 0;
    let gridTotals = {};
    for (let slot of gridSlots) {
      let item = container.getItem(slot);
      if (item) {
        let key = getItemKey(item);
        gridTotals[key] = (gridTotals[key] || 0) + item.amount;
      }
    }
    let possibleCrafts = maxCraftAmount;
    for (const mat of recipe) {
      const available = gridTotals[mat.id] || 0;
      const craftsForMat = Math.floor(available / mat.amount);
      if (craftsForMat === 0) return 0;
      possibleCrafts = Math.min(possibleCrafts, craftsForMat);
    }
    return possibleCrafts;
  } catch (e) {
    return 0;
  }
}
function removeItemsFromGrid(container, gridSlots, itemKey, amount) {
  let remaining = amount;
  for (let slot of gridSlots) {
    if (remaining <= 0) break;
    let item = container.getItem(slot);
    if (item && getItemKey(item) === itemKey) {
      if (item.amount <= remaining) {
        remaining -= item.amount;
        container.setItem(slot, undefined);
      } else {
        container.setItem(slot, createItemFromKey(itemKey, item.amount - remaining));
        remaining = 0;
        break;
      }
    }
  }
}
function updateTerminalInfo(machine, infoSlot, hasEnoughResources) {
  machine.setLabel(hasEnoughResources ? " " : "§r§cNot Enough Resources!", infoSlot);
}
function getBlueprintRecipe(blueprint) {
  if (!blueprint || blueprint.typeId !== OUTPUT_BLUEPRINT_ITEM) return undefined;
  const recipeStr = blueprint.getDynamicProperty("materials");
  if (recipeStr === undefined) return undefined;
  try {
    const recipe = JSON.parse(recipeStr);
    return Array.isArray(recipe) && recipe.length > 0 ? recipe : undefined;
  } catch (e) {
    return undefined;
  }
}
function getBlueprintResult(blueprint) {
  if (!blueprint || blueprint.typeId !== OUTPUT_BLUEPRINT_ITEM) return undefined;
  const id = blueprint.getDynamicProperty("id");
  const amount = Math.floor(Number(blueprint.getDynamicProperty("amount")) || 0);
  if (!id || amount <= 0) return undefined;
  return { id, amount };
}
function splitStoredItemAmount(itemKey, amount) {
  const stacks = [];
  let remaining = Math.floor(Number(amount) || 0);
  if (remaining <= 0) return stacks;
  const testItem = createItemFromKey(itemKey, 1);
  const maxStack = Math.max(1, Number(testItem.maxAmount) || 64);
  while (remaining > 0) {
    const stackAmount = Math.min(maxStack, remaining);
    stacks.push(createItemFromKey(itemKey, stackAmount));
    remaining -= stackAmount;
  }
  return stacks;
}
function splitRawItemAmount(typeId, amount) {
  const stacks = [];
  let remaining = Math.floor(Number(amount) || 0);
  if (!typeId || remaining <= 0) return stacks;
  const testItem = new ItemStack(typeId, 1);
  const maxStack = Math.max(1, Number(testItem.maxAmount) || 64);
  while (remaining > 0) {
    const stackAmount = Math.min(maxStack, remaining);
    stacks.push(new ItemStack(typeId, stackAmount));
    remaining -= stackAmount;
  }
  return stacks;
}
function deliverStack(block, nodes, itemStack, toNetwork) {
  if (toNetwork && nodes.length > 0) {
    const remaining = addItemsToNetwork(nodes, itemStack);
    if (remaining > 0) {
      itemStack.amount = remaining;
      returnToPlayer(block, itemStack);
    }
  } else {
    returnToPlayer(block, itemStack);
  }
}
function deliverStoredItemAmount(block, nodes, itemKey, amount, toNetwork) {
  for (const stack of splitStoredItemAmount(itemKey, amount)) {
    deliverStack(block, nodes, stack, toNetwork);
  }
}
function deliverRawItemAmount(block, nodes, typeId, amount, toNetwork) {
  for (const stack of splitRawItemAmount(typeId, amount)) {
    deliverStack(block, nodes, stack, toNetwork);
  }
}
function consumeCraftMaterials(block, nodes, blueprint, crafts) {
  const recipe = getBlueprintRecipe(blueprint);
  if (nodes.length === 0 || !recipe || crafts <= 0) return false;
  for (const mat of recipe) {
    if (countItemsInNetwork(nodes, mat.id) < mat.amount * crafts) return false;
  }
  for (const mat of recipe) {
    removeItemsFromNetwork(nodes, mat.id, mat.amount * crafts);
  }
  const leftover = blueprint.getDynamicProperty("leftover") || false;
  if (leftover !== false) deliverRawItemAmount(block, nodes, leftover, crafts, true);
  return true;
}
function performCraftButtonAction(entity, inv) {
  const block = getEntityBlock(entity);
  if (!block) return false;
  const blueprint = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
  const recipe = getBlueprintRecipe(blueprint);
  const result = getBlueprintResult(blueprint);
  if (!recipe || !result) return false;

  const nodes = getConnectedInventories(block);
  const outputMode = getOutputMode(entity);
  if (nodes.length === 0) return false;

  const maxCrafts = amountToCraftFromNetwork(blueprint, nodes, Number.MAX_SAFE_INTEGER);
  const crafts = Math.min(getCraftQty(entity), maxCrafts);
  if (crafts <= 0) return false;
  if (!consumeCraftMaterials(block, nodes, blueprint, crafts)) return false;

  deliverStoredItemAmount(block, nodes, result.id, result.amount * crafts, outputMode === "network");
  entity.setDynamicProperty("force_refresh", true);
  return true;
}
function setupCraftingTerminalEntity(entity, block) {
  Terminal.setupBaseEntity(entity, block, {
    nameTag: "entity.utilitycraft:blueprint_terminal.name",
    machineId: "utilitycraft:blueprint_terminal",
    page: -1,
    pageChangeDelayTicks: Terminal.getPageChangeDelayTicks(),
    extraProperties: {
      craft_qty: 1,
      rendered_order: "[]",
      sort_requested: true,
      output_mode: "inventory",
      grid_hash: "",
      is_resolving_recipe: false,
      output_filled: false,
      preview_amount: 0,
      preview_item_key: "",
    },
  });
  if (!initializeBlueprintTerminalInventory(entity)) {
    system.runTimeout(() => initializeBlueprintTerminalInventory(entity), 1);
  }
}
ButtonManager.registerMachineButton("blueprint_terminal", CONTROL_SLOTS, ({ entity, slot }) => {
  if (!entity || !entity.isValid) return;
  if (Terminal.isChunkedRenderActive(entity)) {
    refreshBlueprintTerminalControls(entity);
    return;
  }
  if (entity.getDynamicProperty("is_processing_click")) {
    scheduleBlueprintTerminalRender(entity);
    return;
  }
  entity.setDynamicProperty("is_processing_click", true);
  let changed = false;
  const inv = entity.getComponent("minecraft:inventory").container;
  let currentPage = entity.getDynamicProperty("page") ?? 0;
  const pageCount = getPageCountForEntity(entity);
  currentPage = clampTerminalPage(entity, pageCount);
  if (slot === PREVIOUS_SLOT) {
    if (currentPage > 0) {
      if (!canChangePage(entity)) {
        entity.setDynamicProperty("is_processing_click", false);
        scheduleBlueprintTerminalRender(entity);
        return;
      }
      entity.setDynamicProperty("page", currentPage - 1);
      markPageChanged(entity);
      changed = true;
    }
  } else if (slot === NEXT_SLOT) {
    if (currentPage < pageCount - 1) {
      if (!canChangePage(entity)) {
        entity.setDynamicProperty("is_processing_click", false);
        scheduleBlueprintTerminalRender(entity);
        return;
      }
      entity.setDynamicProperty("page", currentPage + 1);
      markPageChanged(entity);
      changed = true;
    }
  } else if (slot === QUANTITY_SLOT) {
    let currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
    let nextQty = currentQty === 1 ? 16 : currentQty === 16 ? 32 : currentQty === 32 ? 64 : 1;
    entity.setDynamicProperty("extract_quantity", nextQty);
    changed = true;
  } else if (slot === CRAFT_QTY_SLOT) {
    entity.setDynamicProperty("craft_qty", getNextCraftQty(getCraftQty(entity)));
    changed = true;
  } else if (slot === SORT_SLOT) {
    let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
    entity.setDynamicProperty("sort_mode", currentSort === "count" ? "name" : "count");
    entity.setDynamicProperty("sort_requested", true);
    changed = true;
  } else if (slot === OUTPUT_MODE_SLOT) {
    entity.setDynamicProperty("output_mode", getOutputMode(entity) === "network" ? "inventory" : "network");
    changed = true;
  } else if (slot === CRAFT_BUTTON_SLOT) {
    performCraftButtonAction(entity, inv);
    changed = true;
  } else if (slot === REMOVE_RECIPE_SLOT) {
    const block = getEntityBlock(entity);
    const blueprint = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
    if (block && blueprint && blueprint.typeId !== "utilitycraft:storage_filler") {
      returnToPlayer(block, blueprint);
    }
    inv.setItem(CRAFTING_BLUEPRINT_SLOT, undefined);
    inv.setItem(CRAFTING_OUTPUT_SLOT, undefined);
    entity.setDynamicProperty("output_filled", false);
    changed = true;
  }
  if (changed) scheduleBlueprintTerminalRender(entity);
  else refreshBlueprintTerminalControls(entity);
  system.runTimeout(() => {
    if (entity.isValid) entity.setDynamicProperty("is_processing_click", false);
  }, BUTTON_RELEASE_TICKS);
});
function getMachineEntity(block) {
  return block.dimension.getEntitiesAtBlockLocation(block.location).find((e) => e.typeId === "utilitycraft:blueprint_terminal");
}
function getConnectedInventories(startBlock) {
  return Terminal.getConnectedInventories(startBlock);
}
function getNetworkSnapshot(block) {
  const networkId = getNetworkIdForBlock(block);
  const record = readNetworkMeta(networkId);
  return {
    networkId,
    record,
    totals: {},
    version: record?.version ?? 0,
  };
}
function readFullNetworkSnapshot(block, networkId = getNetworkIdForBlock(block)) {
  const record = readNetworkRecord(networkId);
  return {
    networkId,
    record,
    totals: record?.totals ?? {},
    version: record?.version ?? 0,
  };
}
function collectNetworkTotals(nodes) {
  let networkTotals = {};
  for (let node of nodes) {
    if (node.isDrive) {
      for (let i = 1; i <= 9; i++) {
        let data = getCellData(node.container.getItem(i));
        if (data) {
          for (let key in data.items) {
            networkTotals[key] = (networkTotals[key] || 0) + data.items[key];
          }
        }
      }
    } else {
      for (let i = 0; i < node.container.size; i++) {
        let item = node.container.getItem(i);
        if (item) {
          let key = getItemKey(item);
          networkTotals[key] = (networkTotals[key] || 0) + item.amount;
        }
      }
    }
  }
  return networkTotals;
}
function getPageCountFromTotals(networkTotals) {
  return Terminal.getPageCountFromTotals(networkTotals, STORAGE_SLOTS, MAX_PAGES);
}
function getPageCountForEntity(entity) {
  return Terminal.getPageCountForEntity(entity, STORAGE_SLOTS, MAX_PAGES);
}
function clampTerminalPage(entity, pageCount) {
  return Terminal.clampPage(entity, pageCount);
}
function countItemsInNetwork(nodes, itemKey) {
  return Terminal.countItemsInNetwork(nodes, itemKey);
}
function removeItemsFromNetwork(nodes, itemKey, amount) {
  return Terminal.removeItemsFromNetwork(nodes, itemKey, amount);
}
function addItemsToNetwork(nodes, itemToAdd) {
  return Terminal.addItemsToNetwork(nodes, itemToAdd, isStorageCell);
}
function hasBurnSlotItem(inv) {
  const burnItem = inv.getItem(BURN_SLOT);
  return Boolean(burnItem && burnItem.typeId !== "utilitycraft:storage_filler");
}
function hasActionableStorageItems(inv) {
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    const item = inv.getItem(i);
    if (!item || item.typeId === "utilitycraft:storage_filler") continue;
    if (!Terminal.isRenderedVirtualItem(item) && !isStorageCell(item)) return true;
  }

  return false;
}
function hasVisibleVirtualStorageItems(inv) {
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    const item = inv.getItem(i);
    if (!item || item.typeId === "utilitycraft:storage_filler") continue;
    if (Terminal.isRenderedVirtualItem(item)) return true;
  }

  return false;
}
function getSlotStateHash(inv, slot) {
  const item = inv.getItem(slot);
  if (!item) return "empty";
  return `${getItemKey(item)}@${item.amount}`;
}
function getSlotsStateHash(inv, slots) {
  let hash = "";
  for (const slot of slots) hash += `${slot}:${getSlotStateHash(inv, slot)}|`;
  return hash;
}
function syncActivityState(entity, gridState, blueprintState, outputState) {
  entity.setDynamicProperty("last_grid_state_hash", gridState);
  entity.setDynamicProperty("last_blueprint_state_hash", blueprintState);
  entity.setDynamicProperty("last_output_state_hash", outputState);
}
function getRenderedSlotMap(entity) {
  return Terminal.getRenderedSlotMap(entity);
}
function setRenderedSlotMap(entity, pageSlice) {
  Terminal.setRenderedSlotMap(entity, pageSlice, STORAGE_START);
}
function getRenderedOrder(entity) {
  const raw = entity.getDynamicProperty("rendered_order");
  if (typeof raw !== "string" || raw.length === 0) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function appendRenderedOrder(entity, itemKey) {
  const order = getRenderedOrder(entity);
  if (order.includes(itemKey)) return;

  order.push(itemKey);
  entity.setDynamicProperty("rendered_order", JSON.stringify(order));
}
function sortItemKeys(keys, networkTotals, sortMode) {
  return keys.sort((a, b) => {
    if (sortMode === "name") {
      let nameA = a.split("||")[0].split(":").pop();
      let nameB = b.split("||")[0].split(":").pop();
      return nameA.localeCompare(nameB);
    }

    return (networkTotals[b] || 0) - (networkTotals[a] || 0);
  });
}
function getStableRenderedOrder(entity, networkTotals, sortMode) {
  const keys = Object.keys(networkTotals).filter((key) => (networkTotals[key] || 0) > 0);
  const sortRequested = entity.getDynamicProperty("sort_requested") ?? false;
  let order = getRenderedOrder(entity);

  if (sortRequested || order.length === 0) {
    order = sortItemKeys(keys, networkTotals, sortMode);
    entity.setDynamicProperty("sort_requested", false);
  } else {
    const keySet = new Set(keys);
    const orderedSet = new Set();
    order = order.filter((key) => {
      const keep = keySet.has(key);
      if (keep) orderedSet.add(key);
      return keep;
    });
    for (const key of keys) {
      if (!orderedSet.has(key)) order.push(key);
    }
  }

  entity.setDynamicProperty("rendered_order", JSON.stringify(order));
  return order;
}
function findVisibleVirtualSlot(inv, itemKey) {
  return Terminal.findVisibleVirtualSlot(inv, itemKey, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
  });
}
function updateVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty) {
  return Terminal.updateVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
    loreDisplay: LORE_DISPLAY,
  });
}
function isRenderedItemVisible(entity, inv, itemKey) {
  return Terminal.isRenderedItemVisible(entity, inv, itemKey, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
  });
}
function findFreeStorageSlot(inv) {
  let firstFreeSlot = -1;
  let lastUsedSlot = STORAGE_START - 1;
  for (let slot = STORAGE_START; slot <= STORAGE_END; slot++) {
    const item = inv.getItem(slot);
    if (!item || item.typeId === "utilitycraft:storage_filler") {
      if (firstFreeSlot < 0) firstFreeSlot = slot;
      continue;
    }
    lastUsedSlot = slot;
  }

  const appendSlot = lastUsedSlot + 1;
  if (appendSlot >= STORAGE_START && appendSlot <= STORAGE_END) {
    const item = inv.getItem(appendSlot);
    if (!item || item.typeId === "utilitycraft:storage_filler") return appendSlot;
  }

  return firstFreeSlot;
}
function renderVirtualItemAtSlot(entity, inv, machine, networkId, itemKey, count, currentQty, slot) {
  const virtualItemTest = createItemFromKey(itemKey, 1);
  const maxStack = virtualItemTest.maxAmount ?? 64;
  const renderAmount = Math.min(currentQty, count, maxStack);
  const virtualItem = createItemFromKey(itemKey, renderAmount);
  const currentLore = virtualItem.getLore() || [];
  applyVirtualLore(
    virtualItem,
    [...currentLore, `${LORE_DISPLAY}${count}`],
    networkId,
    itemKey,
    { entityId: entity.id, slot, count },
  );
  inv.setItem(slot, virtualItem);
  Terminal.syncBlueprintDataAtSlot(entity, slot, virtualItem);

  const renderedSlots = getRenderedSlotMap(entity);
  renderedSlots[itemKey] = slot;
  entity.setDynamicProperty("rendered_slot_keys", JSON.stringify(renderedSlots));
  appendRenderedOrder(entity, itemKey);
}
function updateOrAppendVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty) {
  const renderedSlots = getRenderedSlotMap(entity);
  if (Number.isInteger(renderedSlots[itemKey]) || isRenderedItemVisible(entity, inv, itemKey)) {
    return updateVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty);
  }

  if (count <= 0) return true;

  const freeSlot = findFreeStorageSlot(inv);
  if (freeSlot < 0) return true;

  try {
    renderVirtualItemAtSlot(entity, inv, machine, networkId, itemKey, count, currentQty, freeSlot);
    return true;
  } catch {
    entity.setDynamicProperty("force_refresh", true);
    return false;
  }
}
function applyNetworkDeltas(entity, inv, machine, networkRecord, networkId, currentQty) {
  return Terminal.applyNetworkDeltas(entity, inv, machine, networkRecord, networkId, currentQty, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
    loreDisplay: LORE_DISPLAY,
    appendVisibleItem: (itemKey, count) =>
      updateOrAppendVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty),
  });
}
function syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion) {
  Terminal.syncNetworkState(entity, networkRecord, networkTotals, networkVersion);
}
async function renderBlueprintTerminalPage(
  entity,
  inv,
  machine,
  networkId,
  hasNetwork,
  networkTotals,
  currentPage,
  pageCount,
  currentQty,
  currentCraftQty,
  currentSort,
) {
  renderBlueprintTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);

  let pageSlice = [];
  if (hasNetwork) {
    const sortedTypes = getStableRenderedOrder(entity, networkTotals, currentSort);
    const startIdx = currentPage * STORAGE_SLOTS;
    pageSlice = sortedTypes.slice(startIdx, startIdx + STORAGE_SLOTS);
    setRenderedSlotMap(entity, pageSlice);
  } else {
    setRenderedSlotMap(entity, []);
  }

  await Terminal.renderVirtualGridChunked({
    entity,
    inv,
    machine,
    networkId,
    hasNetwork,
    networkTotals,
    pageSlice,
    currentQty,
    storageStart: STORAGE_START,
    storageSlots: STORAGE_SLOTS,
    loreDisplay: LORE_DISPLAY,
    spreadTicks: Terminal.getGridReloadSpreadTicks(),
  });
}
function runCraftingStorageTerminalTick(block, machineEntity, settings) {
  const entity = machineEntity;
  const isProxy = entity.getDynamicProperty("is_proxy");
  if (isProxy) return;
  if (!entity || !entity.isValid) return;
  if (Terminal.isChunkedRenderActive(entity)) return;
  const machine = new Terminal(block, settings);
  if (!machine || !machine.valid) return;
  if (!machine.shouldUpdateUI) return;
  const inv = entity.getComponent("minecraft:inventory").container;
  Terminal.repairFillerSlots(inv, RESERVED_FILLER_SLOTS, {
    entity,
    onBlockedItem: (item) => returnToPlayer(block, item),
  });
  ButtonManager.ensureWatching(entity, "blueprint_terminal");
  const networkSnapshot = getNetworkSnapshot(block);
  let currentPage = entity.getDynamicProperty("page") ?? 0;
  let lastRendered = entity.getDynamicProperty("last_rendered_page") ?? -1;
  let lastPageCount = entity.getDynamicProperty("last_rendered_page_count") ?? -1;
  let pageCount = Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(lastPageCount)) || 1));
  currentPage = clampTerminalPage(entity, pageCount);
  let currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
  let currentCraftQty = getCraftQty(entity);
  let lastQty = entity.getDynamicProperty("last_rendered_qty") ?? -1;
  let lastCraftQty = entity.getDynamicProperty("last_rendered_craft_qty") ?? -1;
  let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
  let lastSort = entity.getDynamicProperty("last_rendered_sort") ?? "";
  let currentOutputMode = getOutputMode(entity);
  let lastOutputMode = entity.getDynamicProperty("last_rendered_output_mode") ?? "";
  let forceRefresh = entity.getDynamicProperty("force_refresh") ?? false;
  let controlsChanged = controlsNeedRender(inv);
  const currentTick = system.currentTick ?? 0;
  const gridNeedsRepair = false;
  let pageChanged = false;
  let networkVersion = networkSnapshot.version;
  const lastNetworkVersion = entity.getDynamicProperty("last_network_version") ?? -1;
  const hasNetworkSnapshot = Boolean(networkSnapshot.networkId);
  const hasNetworkOnline = hasNetworkSnapshot && networkSnapshot.record?.online === true;
  const wasNetworkAvailable = entity.getDynamicProperty("last_network_available") === true;
  if (hasNetworkOnline !== wasNetworkAvailable) {
    forceRefresh = true;
    entity.setDynamicProperty("force_refresh", true);
    entity.setDynamicProperty("last_rendered_page", -1);
  }
  entity.setDynamicProperty("last_network_available", hasNetworkOnline);
  const hasRenderedNetworkItems = !hasNetworkOnline && (
    Object.keys(getRenderedSlotMap(entity)).length > 0 ||
    hasVisibleVirtualStorageItems(inv)
  );
  if (!hasNetworkOnline && hasRenderedNetworkItems) {
    forceRefresh = true;
    entity.setDynamicProperty("force_refresh", true);
    entity.setDynamicProperty("last_rendered_page", -1);
  }
  const hasPendingBurnSlot = hasBurnSlotItem(inv);
  const stateBlueprintItem = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
  const hasCraftBlueprint = stateBlueprintItem && stateBlueprintItem.typeId === OUTPUT_BLUEPRINT_ITEM;
  const gridState = "no_grid";
  const blueprintState = getSlotStateHash(inv, CRAFTING_BLUEPRINT_SLOT);
  const outputState = getSlotStateHash(inv, CRAFTING_OUTPUT_SLOT);
  const activityChanged =
    gridState !== (entity.getDynamicProperty("last_grid_state_hash") ?? "") ||
    blueprintState !== (entity.getDynamicProperty("last_blueprint_state_hash") ?? "") ||
    outputState !== (entity.getDynamicProperty("last_output_state_hash") ?? "");
  if (activityChanged) {
    syncActivityState(entity, gridState, blueprintState, outputState);
  }
  const shouldScanInput = forceRefresh || hasPendingBurnSlot || currentTick % 10 === 0;
  const hasPendingInput = hasPendingBurnSlot || (shouldScanInput ? hasActionableStorageItems(inv) : false);
  const canUseNetworkDeltas =
    hasNetworkOnline &&
    !hasCraftBlueprint &&
    !forceRefresh &&
    !controlsChanged &&
    !hasPendingInput &&
    !activityChanged &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentCraftQty === lastCraftQty &&
    currentSort === lastSort &&
    currentOutputMode === lastOutputMode &&
    networkVersion !== lastNetworkVersion;
  if (canUseNetworkDeltas) {
    const handledByDeltas = applyNetworkDeltas(entity, inv, machine, networkSnapshot.record, networkSnapshot.networkId, currentQty);
    if (handledByDeltas === "reload") {
      const fullSnapshot = readFullNetworkSnapshot(block, networkSnapshot.networkId);
      const nextPageCount = getPageCountFromTotals(fullSnapshot.totals);
      const nextPage = Math.max(0, Math.min(currentPage, nextPageCount - 1));
      if (nextPage !== currentPage) entity.setDynamicProperty("page", nextPage);
      renderBlueprintTerminalPage(
        entity,
        inv,
        machine,
        fullSnapshot.networkId,
        Boolean(fullSnapshot.networkId && fullSnapshot.record?.online === true),
        fullSnapshot.totals,
        nextPage,
        nextPageCount,
        currentQty,
        currentCraftQty,
        currentSort,
      );
      syncTerminalNetworkState(entity, fullSnapshot.record, fullSnapshot.totals, fullSnapshot.version);
      entity.setDynamicProperty("force_refresh", false);
      return;
    }
    if (handledByDeltas) {
      syncTerminalNetworkState(entity, networkSnapshot.record, undefined, networkVersion);
      entity.setDynamicProperty("force_refresh", false);
      return;
    }
    syncTerminalNetworkState(entity, networkSnapshot.record, undefined, networkVersion);
    entity.setDynamicProperty("force_refresh", false);
    return;
  }
  if (
    !forceRefresh &&
    !controlsChanged &&
    !gridNeedsRepair &&
    !hasPendingInput &&
    !activityChanged &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentCraftQty === lastCraftQty &&
    currentSort === lastSort &&
    currentOutputMode === lastOutputMode &&
    networkVersion === lastNetworkVersion
  ) {
    return;
  }
  if (
    controlsChanged &&
    !forceRefresh &&
    !gridNeedsRepair &&
    !hasPendingInput &&
    !activityChanged &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentCraftQty === lastCraftQty &&
    currentSort === lastSort &&
    currentOutputMode === lastOutputMode &&
    networkVersion === lastNetworkVersion
  ) {
    renderBlueprintTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);
    return;
  }

  const fullSnapshot = readFullNetworkSnapshot(block, networkSnapshot.networkId);
  networkSnapshot.record = fullSnapshot.record;
  networkSnapshot.totals = fullSnapshot.totals;
  networkVersion = fullSnapshot.version;
  pageCount = getPageCountFromTotals(networkSnapshot.totals);
  currentPage = clampTerminalPage(entity, pageCount);

  const terminalStateChanged =
    currentPage !== lastRendered ||
    pageCount !== lastPageCount ||
    currentQty !== lastQty ||
    currentCraftQty !== lastCraftQty ||
    currentSort !== lastSort ||
    currentOutputMode !== lastOutputMode ||
    gridNeedsRepair;
  const controlsNeedUpdate = controlsChanged || terminalStateChanged;
  if (controlsNeedUpdate) {
    if (terminalStateChanged) pageChanged = true;
    renderBlueprintTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);
  }
  let nodes = getConnectedInventories(block);
  let networkRecord = nodes.record ?? readNetworkRecord(nodes.networkId);
  let networkTotals = Object.assign({}, networkRecord?.totals ?? {});
  networkVersion = networkRecord?.version ?? networkVersion;
  let hasNetwork = nodes.length > 0;
  let currentBurnItem = inv.getItem(BURN_SLOT);
  if (currentBurnItem && currentBurnItem.typeId === "utilitycraft:storage_filler") {
    inv.setItem(BURN_SLOT, undefined);
    currentBurnItem = undefined;
  }
  if (hasNetwork && currentBurnItem && getStoredCount(currentBurnItem) !== -1) {
    let itemKey = getItemKey(currentBurnItem);
    let maxStack = currentBurnItem.maxAmount;
    inv.setItem(BURN_SLOT, undefined);
    let available = countItemsInNetwork(nodes, itemKey);
    let take = Math.min(maxStack, available);
    if (take > 0) {
      removeItemsFromNetwork(nodes, itemKey, take);
      returnToPlayer(block, createItemFromKey(itemKey, take));
      const updatedNetwork = readNetworkRecord(nodes.networkId);
      const updatedTotals = updatedNetwork?.totals ?? {};
      const newCount = Number(updatedTotals[itemKey] ?? 0);
      if (newCount <= 0) {
        forceRefresh = true;
        pageChanged = true;
      } else {
        updateVisibleVirtualItem(entity, inv, machine, nodes.networkId, itemKey, newCount, currentQty);
        syncTerminalNetworkState(entity, updatedNetwork, updatedTotals, updatedNetwork?.version ?? networkVersion);
        return;
      }
    }
  }
  if (hasPendingInput) {
    for (let i = STORAGE_START; i <= STORAGE_END; i++) {
      let item = inv.getItem(i);
      if (!item) continue;
      if (item.typeId === "utilitycraft:storage_filler") continue;
      if (!Terminal.isRenderedVirtualItem(item) && !isStorageCell(item)) {
        let burnItem = inv.getItem(BURN_SLOT);
        if (!burnItem) {
          inv.setItem(BURN_SLOT, item);
          inv.setItem(i, undefined);
          entity.setDynamicProperty("force_refresh", true);
        } else if (getItemKey(burnItem) === getItemKey(item) && burnItem.amount < burnItem.maxAmount) {
          let space = burnItem.maxAmount - burnItem.amount;
          let transfer = Math.min(space, item.amount);
          let combinedItem = createItemFromKey(getItemKey(burnItem), burnItem.amount + transfer);
          inv.setItem(BURN_SLOT, combinedItem);
          let leftover = item.amount - transfer;
          if (leftover > 0) returnToPlayer(block, createItemFromKey(getItemKey(item), leftover));
          inv.setItem(i, undefined);
          entity.setDynamicProperty("force_refresh", true);
        } else {
          returnToPlayer(block, item);
          inv.setItem(i, undefined);
          entity.setDynamicProperty("force_refresh", true);
        }
      }
    }
  }
  if (hasNetwork) {
    let burnItem = inv.getItem(BURN_SLOT);
    if (burnItem && getStoredCount(burnItem) === -1) {
      let originalAmount = burnItem.amount;
      let remaining = addItemsToNetwork(nodes, burnItem);
      if (remaining < originalAmount) {
        const itemKey = getItemKey(burnItem);
        inv.setItem(BURN_SLOT, remaining === 0 ? undefined : createItemFromKey(itemKey, remaining));
        const updatedNetwork = readNetworkRecord(nodes.networkId);
        const updatedTotals = updatedNetwork?.totals ?? {};
        const newCount = Number(updatedTotals[itemKey] ?? 0);
        if (updateOrAppendVisibleVirtualItem(entity, inv, machine, nodes.networkId, itemKey, newCount, currentQty)) {
          syncTerminalNetworkState(entity, updatedNetwork, updatedTotals, updatedNetwork?.version ?? networkVersion);
          if (!forceRefresh) {
            entity.setDynamicProperty("force_refresh", false);
          }
          return;
        }
        entity.setDynamicProperty("force_refresh", true);
        syncTerminalNetworkState(entity, updatedNetwork, updatedTotals, updatedNetwork?.version ?? networkVersion);
        return;
      }
    }
  }
  let blueprintItem = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
  if (hasNetwork && blueprintItem && getStoredCount(blueprintItem) !== -1) {
    let itemKey = getItemKey(blueprintItem);
    inv.setItem(CRAFTING_BLUEPRINT_SLOT, undefined);
    let available = countItemsInNetwork(nodes, itemKey);
    let maxStack = createItemFromKey(itemKey, 1).maxAmount ?? 64;
    let take = Math.min(blueprintItem.amount, maxStack, available);
    if (take > 0) {
      removeItemsFromNetwork(nodes, itemKey, take);
      let realItem = createItemFromKey(itemKey, take);
      inv.setItem(CRAFTING_BLUEPRINT_SLOT, realItem);
      const updatedNetwork = readNetworkRecord(nodes.networkId);
      const updatedTotals = updatedNetwork?.totals ?? {};
      const newCount = Number(updatedTotals[itemKey] ?? 0);
      if (newCount <= 0) {
        forceRefresh = true;
        pageChanged = true;
      } else {
        updateVisibleVirtualItem(entity, inv, machine, nodes.networkId, itemKey, newCount, currentQty);
        syncTerminalNetworkState(entity, updatedNetwork, updatedTotals, updatedNetwork?.version ?? networkVersion);
      }
    }
  }
  let prevActive = entity.getDynamicProperty("output_filled") ?? false;
  const blueprintResult = getBlueprintResult(blueprintItem);
  const hasEnoughResources =
    Boolean(blueprintResult && hasNetwork && amountToCraftFromNetwork(blueprintItem, nodes, 1) > 0);
  updateTerminalInfo(machine, CRAFTING_INFO_PANEL_SLOT, !blueprintResult || hasEnoughResources);

  if (blueprintResult) {
    const maxStack = createItemFromKey(blueprintResult.id, 1).maxAmount ?? 64;
    const displayAmount = Math.min(maxStack, blueprintResult.amount);
    let existingOutput = inv.getItem(CRAFTING_OUTPUT_SLOT);
    const isCorrectPreview =
      existingOutput &&
      existingOutput.typeId !== "utilitycraft:storage_filler" &&
      getItemKey(existingOutput) === blueprintResult.id &&
      existingOutput.amount === displayAmount;
    if (!isCorrectPreview) {
      if (existingOutput && existingOutput.typeId !== "utilitycraft:storage_filler" && !prevActive) {
        returnToPlayer(block, existingOutput);
      }
      let previewItem = createItemFromKey(blueprintResult.id, displayAmount);
      previewItem.setLore(OUTPUT_PREVIEW_LORE);
      inv.setItem(CRAFTING_OUTPUT_SLOT, previewItem);
      entity.setDynamicProperty("output_filled", true);
      entity.setDynamicProperty("preview_amount", displayAmount);
      entity.setDynamicProperty("preview_item_key", blueprintResult.id);
    }
  } else {
    if (prevActive) {
      inv.setItem(CRAFTING_OUTPUT_SLOT, undefined);
      entity.setDynamicProperty("output_filled", false);
    }
    let checkOutput = inv.getItem(CRAFTING_OUTPUT_SLOT);
    if (checkOutput && checkOutput.typeId !== "utilitycraft:storage_filler") {
      returnToPlayer(block, checkOutput);
      checkOutput = undefined;
    }
    if (!checkOutput || (checkOutput.typeId === "utilitycraft:storage_filler" && checkOutput.nameTag !== "§rOutput Slot")) {
      let filler = new ItemStack("utilitycraft:storage_filler", 1);
      filler.nameTag = "§rOutput Slot";
      inv.setItem(CRAFTING_OUTPUT_SLOT, filler);
    }
  }
  if (hasNetwork) {
    const latestNetwork = readNetworkRecord(nodes.networkId);
    if (latestNetwork) {
      networkRecord = latestNetwork;
      networkTotals = Object.assign({}, latestNetwork.totals ?? {});
      networkVersion = latestNetwork.version ?? networkVersion;
    }
  }

  if (
    hasNetwork &&
    !forceRefresh &&
    !pageChanged &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentCraftQty === lastCraftQty &&
    currentSort === lastSort &&
    currentOutputMode === lastOutputMode &&
    networkVersion !== lastNetworkVersion
  ) {
    const handledByDeltas = applyNetworkDeltas(entity, inv, machine, networkRecord, nodes.networkId, currentQty);
    if (handledByDeltas === "reload") {
      forceRefresh = true;
      pageChanged = true;
    } else if (handledByDeltas) {
      const nextPageCount = getPageCountFromTotals(networkTotals);
      const nextPage = Math.max(0, Math.min(currentPage, nextPageCount - 1));
      if (nextPage !== currentPage) {
        entity.setDynamicProperty("page", nextPage);
        forceRefresh = true;
        pageChanged = true;
      } else {
        syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion);
        if (nextPageCount !== lastPageCount) {
          const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
          prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${nextPageCount}`;
          inv.setItem(PREVIOUS_SLOT, prevItem);
          const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
          nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${nextPageCount}`;
          inv.setItem(NEXT_SLOT, nextItem);
          entity.setDynamicProperty("last_rendered_page_count", nextPageCount);
        }
        entity.setDynamicProperty("force_refresh", false);
        return;
      }
    } else {
      forceRefresh = true;
      pageChanged = true;
    }
  }

  const shouldRenderTerminal = forceRefresh || pageChanged;
  if (shouldRenderTerminal) {
    pageCount = getPageCountFromTotals(networkTotals);
    currentPage = clampTerminalPage(entity, pageCount);
    renderBlueprintTerminalPage(
      entity,
      inv,
      machine,
      nodes.networkId,
      hasNetwork,
      networkTotals,
      currentPage,
      pageCount,
      currentQty,
      currentCraftQty,
      currentSort,
    );
    syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion);
    entity.setDynamicProperty("force_refresh", false);
    return;
  }
}
function resolveRecipeAsync(dimension, location, gridItems, entity) {
  const minY = DoriosAPI.constants.dimensions[dimension.id.split(":")[1] || "overworld"]?.minY ?? 0;
  let { x, z } = location;
  x += 0.5;
  z += 0.5;
  const crafterBlockId = dimension.getBlock({ x, y: minY, z })?.typeId;
  const redstoneBlockId = dimension.getBlock({ x, y: minY + 1, z })?.typeId;
  dimension.setBlockType({ x, y: minY, z }, "minecraft:crafter");
  let materialMap = {};
  let materialCount = 0;
  let recipeArray = [];
  for (let i = 0; i < 9; i++) {
    const item = gridItems[i];
    if (item) {
      materialCount++;
      let key = getItemKey(item);
      materialMap[key] = (materialMap[key] || 0) + 1;
      dimension.runCommand(`replaceitem block ${x} ${minY} ${z} slot.container ${i} ${item.typeId}`);
      recipeArray.push(item.typeId.split(":")[1]);
    } else {
      recipeArray.push("air");
    }
  }
  if (materialCount === 0) {
    entity.setDynamicProperty("is_resolving_recipe", false);
    return;
  }
  dimension.setBlockType({ x, y: minY + 1, z }, "minecraft:redstone_block");
  const recipeString = recipeArray.join(",");
  system.runTimeout(() => {
    if (!entity.isValid) return;
    const itemEntity = dimension.getEntitiesAtBlockLocation({
      x,
      y: minY - 1,
      z,
    })[0];
    let outputId = null;
    let outputAmount = 0;
    let leftoverId = false;
    if (itemEntity) {
      const itemStack = itemEntity.getComponent("minecraft:item").itemStack;
      outputAmount = itemStack.amount;
      outputId = itemStack.typeId;
      itemEntity.remove();
    } else {
      const itemRecipe = crafterRecipes ? crafterRecipes[recipeString] : null;
      if (itemRecipe) {
        outputAmount = itemRecipe.amount;
        outputId = itemRecipe.output;
        leftoverId = itemRecipe.leftover || false;
      }
    }
    const inv = entity.getComponent("minecraft:inventory").container;
    if (outputId) {
      const recipeData = Object.entries(materialMap).map(([id, amount]) => ({
        id,
        amount,
      }));
      const newBlueprint = new ItemStack(OUTPUT_BLUEPRINT_ITEM, 1);
      newBlueprint.setDynamicProperty("id", outputId);
      newBlueprint.setDynamicProperty("amount", outputAmount);
      newBlueprint.setDynamicProperty("materials", JSON.stringify(recipeData));
      if (leftoverId) newBlueprint.setDynamicProperty("leftover", leftoverId);
      const formatItemId = (id) =>
        id
          .split(":")[1]
          .split("_")
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(" ");
      newBlueprint.setLore([
        `\u00A7r\u00A77 Recipe: \u00A7r\u00A7f${formatItemId(outputId)}`,
        "\u00A7r\u00A77 Materials:",
        ...recipeData.map((m) => `\u00A7r\u00A77 - ${formatItemId(m.id)} x${m.amount}`),
      ]);
      inv.setItem(CRAFTING_BLUEPRINT_SLOT, newBlueprint);
    } else {
      inv.setItem(CRAFTING_BLUEPRINT_SLOT, undefined);
    }
    for (let slot = 0; slot < 9; slot++) {
      dimension.runCommand(`replaceitem block ${x} ${minY} ${z} slot.container ${slot} air`);
    }
    dimension.setBlockType({ x, y: minY, z }, crafterBlockId || "minecraft:bedrock");
    dimension.setBlockType({ x, y: minY + 1, z }, redstoneBlockId || "minecraft:bedrock");
    entity.setDynamicProperty("is_resolving_recipe", false);
  }, 9);
}
DoriosAPI.register.blockComponent("blueprint_terminal", {
  beforeOnPlayerPlace(e, { params: settings }) {
    Terminal.onPlace(e, settings, {
      entityType: "utilitycraft:blueprint_terminal",
      setupEntity: setupCraftingTerminalEntity,
    });
  },
  onTick(e, { params: settings }) {
    const { block } = e;
    const entity = getMachineEntity(block);
    if (!entity || !entity.isValid) return;
    runCraftingStorageTerminalTick(block, entity, settings);
  },
  onPlayerBreak(e) {
    const { block, dimension } = e;
    updateNetworkAround(block);
    const entity = getMachineEntity(block);
    if (entity && entity.isValid) {
      const inv = entity.getComponent("minecraft:inventory").container;
      let burnItem = inv.getItem(BURN_SLOT);
      let blueprint = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
      let output = inv.getItem(CRAFTING_OUTPUT_SLOT);
      let itemsToDrop = [];
      if (burnItem && getStoredCount(burnItem) === -1) itemsToDrop.push(burnItem);
      if (blueprint) itemsToDrop.push(blueprint);
      let prevActive = entity.getDynamicProperty("output_filled");
      if (output && getStoredCount(output) === -1 && output.typeId !== "utilitycraft:storage_filler" && !prevActive) {
        itemsToDrop.push(output);
      }
      inv.clearAll();
      for (let item of itemsToDrop) {
        dimension.spawnItem(item, block.center());
      }
      entity.triggerEvent("despawn");
    }
    Terminal.onDestroy(e);
  },
});
