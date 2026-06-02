// Imports

import { ItemStack, system } from "@minecraft/server";
import { ButtonManager } from "DoriosCore/index.js";
import { Terminal } from "Machinery/core/terminal.js";
import { getCellData, cellCapacities } from "Machinery/blocks/disk_drive.js";
import { getNetworkIdForBlock, updateNetworkAround } from "Machinery/storage/network_manager.js";
import { readNetworkMeta, readNetworkRecord } from "Machinery/storage/storage_db.js";
import { applyVirtualLore, needsVirtualLoreRewrite } from "Machinery/storage/virtual_item_codec.js";
import { crafterRecipes } from "Config/recipes/crafter.js";

// Constant

const BURN_SLOT = 119;
const STORAGE_START = 0;
const STORAGE_END = 107;
const COUNT_LABEL_BASE_SLOT = 108;
const NEXT_SLOT = 120;
const PREVIOUS_SLOT = 121;
const QUANTITY_SLOT = 122;
const SORT_SLOT = 123;
const CRAFT_QTY_SLOT = 124;
const REMOVE_RECIPE_SLOT = 125;
const CRAFTING_BLUEPRINT_SLOT = 126;
const CRAFTING_GRID = [127, 128, 129, 130, 131, 132, 133, 134, 135];
const OUTPUT_SLOT = 136;
const CRAFT_BUTTON_SLOT = 137;
const OUTPUT_MODE_SLOT = 138;
const LORE_DISPLAY = "§r§7- Count: §f";
const MAX_PAGES = 27;
const STORAGE_SLOTS = 108;
const OUTPUT_BLUEPRINT_ITEM = "utilitycraft:blueprint";
const RESERVED_FILLER_SLOTS = [117, 118];
const ITEM_EXPORTER = "utilitycraft:item_exporter";
const ITEM_IMPORTER = "utilitycraft:item_importer";
const MC_MAPS = {
  "minecraft:overworld": DoriosAPI.constants.dimensions.overworld.minY,
  "minecraft:nether": DoriosAPI.constants.dimensions.nether.minY,
  "minecraft:the_end": DoriosAPI.constants.dimensions.end.minY,
};
const CONTROL_SLOTS = [
  PREVIOUS_SLOT,
  NEXT_SLOT,
  QUANTITY_SLOT,
  CRAFT_QTY_SLOT,
  SORT_SLOT,
  REMOVE_RECIPE_SLOT,
  CRAFT_BUTTON_SLOT,
  OUTPUT_MODE_SLOT,
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
const PAGE_CHANGE_DELAY_TICKS = 4;
const GRID_REPAIR_TICKS = 200;

// Main Work (Functions)

function getEntityBlock(entity) {
  return Terminal.getEntityBlock(entity);
}
function renderCraftingTerminalNow(entity) {
  try {
    if (!entity || !entity.isValid) return;
    const block = getEntityBlock(entity);
    if (!block) return;
    runCraftingStorageTerminalTick(block, entity, RENDER_SETTINGS);
  } catch (e) {
    console.warn("Crafting terminal button render skipped.");
  }
}
function scheduleCraftingTerminalRender(entity) {
  system.runTimeout(() => renderCraftingTerminalNow(entity), 1);
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
function renderCraftingTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort) {
  const qtyItem = new ItemStack("utilitycraft:ui_filler", 1);
  qtyItem.nameTag = `§r§7- Quantity: §f${currentQty}`;
  inv.setItem(QUANTITY_SLOT, qtyItem);
  const craftQtyItem = new ItemStack("utilitycraft:ui_filler", 1);
  craftQtyItem.nameTag = `§r§fx${currentCraftQty}`;
  inv.setItem(CRAFT_QTY_SLOT, craftQtyItem);
  const sortItem = new ItemStack("utilitycraft:ui_filler", 1);
  sortItem.nameTag = `§r§7- Sort By: §f${currentSort === "name" ? "Name" : "Count"}`;
  inv.setItem(SORT_SLOT, sortItem);
  const clearRecipeItem = new ItemStack("utilitycraft:ui_filler", 1);
  clearRecipeItem.nameTag = `§r§cClear Recipe`;
  inv.setItem(REMOVE_RECIPE_SLOT, clearRecipeItem);
  const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
  prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${pageCount}`;
  inv.setItem(PREVIOUS_SLOT, prevItem);
  const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
  nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${pageCount}`;
  inv.setItem(NEXT_SLOT, nextItem);
  const craftItem = new ItemStack("utilitycraft:ui_filler", 1);
  craftItem.nameTag = "§r§fCraft";
  inv.setItem(CRAFT_BUTTON_SLOT, craftItem);
  const outputMode = getOutputMode(entity);
  const modeItem = new ItemStack("utilitycraft:ui_filler", 1);
  modeItem.nameTag = outputMode === "network" ? "§r§fTo Network" : "§r§fTo Inventory";
  inv.setItem(OUTPUT_MODE_SLOT, modeItem);
  entity.setDynamicProperty("last_rendered_page", currentPage);
  entity.setDynamicProperty("last_rendered_page_count", pageCount);
  entity.setDynamicProperty("last_rendered_qty", currentQty);
  entity.setDynamicProperty("last_rendered_craft_qty", currentCraftQty);
  entity.setDynamicProperty("last_rendered_sort", currentSort);
  entity.setDynamicProperty("last_rendered_output_mode", outputMode);
}
function refreshCraftingTerminalControls(entity) {
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
    renderCraftingTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);
  } catch (e) {}
}
function canChangePage(entity) {
  return Terminal.canChangePage(entity, PAGE_CHANGE_DELAY_TICKS);
}
function markPageChanged(entity) {
  Terminal.markPageChanged(entity);
}
function isStorageCell(item) {
  if (!item) return false;
  return item.typeId in cellCapacities;
}
function amountToCraftFromNetwork(blueprint, nodes, maxCraftsRequested) {
  const recipeStr = blueprint.getDynamicProperty("materials");
  if (recipeStr === undefined) return 0;
  try {
    const recipe = JSON.parse(recipeStr);
    if (!Array.isArray(recipe) || recipe.length === 0) return 0;
    let possibleCrafts = Infinity;
    for (const mat of recipe) {
      let available = countItemsInNetwork(nodes, mat.id);
      let craftsForMat = Math.floor(available / mat.amount);
      if (craftsForMat === 0) return 0;
      possibleCrafts = Math.min(possibleCrafts, craftsForMat);
    }
    if (possibleCrafts === Infinity) return 0;
    return Math.min(possibleCrafts, maxCraftsRequested);
  } catch (e) {
    return 0;
  }
}
function countItemsInGrid(inv, itemKey) {
  let total = 0;
  for (const slot of CRAFTING_GRID) {
    const item = inv.getItem(slot);
    if (item && getItemKey(item) === itemKey) total += item.amount;
  }
  return total;
}
function amountToCraftFromGrid(blueprint, inv) {
  const recipeStr = blueprint.getDynamicProperty("materials");
  if (recipeStr === undefined) return 0;
  try {
    const recipe = JSON.parse(recipeStr);
    if (!Array.isArray(recipe) || recipe.length === 0) return 0;
    let possibleCrafts = Infinity;
    for (const mat of recipe) {
      const available = countItemsInGrid(inv, mat.id);
      const craftsForMat = Math.floor(available / mat.amount);
      if (craftsForMat <= 0) return 0;
      possibleCrafts = Math.min(possibleCrafts, craftsForMat);
    }
    return possibleCrafts === Infinity ? 0 : possibleCrafts;
  } catch (e) {
    return 0;
  }
}
function consumeRecipeFromGrid(inv, recipe, crafts) {
  if (!Array.isArray(recipe) || crafts <= 0) return false;

  for (const mat of recipe) {
    if (countItemsInGrid(inv, mat.id) < mat.amount * crafts) return false;
  }

  for (const mat of recipe) {
    let remaining = mat.amount * crafts;
    for (const slot of CRAFTING_GRID) {
      if (remaining <= 0) break;
      const item = inv.getItem(slot);
      if (!item || getItemKey(item) !== mat.id) continue;

      const take = Math.min(item.amount, remaining);
      remaining -= take;
      if (take >= item.amount) {
        inv.setItem(slot, undefined);
      } else {
        item.amount -= take;
        inv.setItem(slot, item);
      }
    }
  }

  return true;
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
function setupCraftingTerminalEntity(entity, block) {
  Terminal.setupBaseEntity(entity, block, {
    nameTag: "entity.utilitycraft:crafting_terminal.name",
    page: -1,
    pageChangeDelayTicks: PAGE_CHANGE_DELAY_TICKS,
    extraProperties: {
      craft_qty: 1,
      rendered_order: "[]",
      sort_requested: true,
      output_mode: "inventory",
      grid_hash: "",
      is_resolving_recipe: false,
      preview_active: false,
      preview_source: "",
      preview_crafts: 0,
      preview_item_key: "",
      preview_amount: 0,
    },
  });
}
function getGridHash(inv) {
  let hash = "";
  for (let slot of CRAFTING_GRID) {
    let item = inv.getItem(slot);
    hash += item ? `${item.typeId}|` : "empty|";
  }
  return hash;
}
function resolveRecipeAsync(dimension, location, gridItems, entity) {
  const minY = MC_MAPS[dimension.id];
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
ButtonManager.registerMachineButton("crafting_terminal", CONTROL_SLOTS, ({ entity, slot }) => {
  if (!entity || !entity.isValid) return;
  if (Terminal.isChunkedRenderActive(entity)) {
    refreshCraftingTerminalControls(entity);
    return;
  }
  if (entity.getDynamicProperty("is_processing_click")) {
    scheduleCraftingTerminalRender(entity);
    return;
  }
  entity.setDynamicProperty("is_processing_click", true);
  entity.setDynamicProperty("force_refresh", true);
  const inv = entity.getComponent("minecraft:inventory").container;
  let currentPage = entity.getDynamicProperty("page") ?? 0;
  const pageCount = getPageCountForEntity(entity);
  currentPage = clampTerminalPage(entity, pageCount);
  if (slot === PREVIOUS_SLOT) {
    if (currentPage > 0) {
      if (!canChangePage(entity)) {
        entity.setDynamicProperty("is_processing_click", false);
        scheduleCraftingTerminalRender(entity);
        return;
      }
      entity.setDynamicProperty("page", currentPage - 1);
      markPageChanged(entity);
    }
  } else if (slot === NEXT_SLOT) {
    if (currentPage < pageCount - 1) {
      if (!canChangePage(entity)) {
        entity.setDynamicProperty("is_processing_click", false);
        scheduleCraftingTerminalRender(entity);
        return;
      }
      entity.setDynamicProperty("page", currentPage + 1);
      markPageChanged(entity);
    }
  } else if (slot === QUANTITY_SLOT) {
    let currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
    let nextQty = currentQty === 1 ? 16 : currentQty === 16 ? 32 : currentQty === 32 ? 64 : 1;
    entity.setDynamicProperty("extract_quantity", nextQty);
  } else if (slot === CRAFT_QTY_SLOT) {
    entity.setDynamicProperty("craft_qty", getNextCraftQty(getCraftQty(entity)));
  } else if (slot === SORT_SLOT) {
    let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
    entity.setDynamicProperty("sort_mode", currentSort === "count" ? "name" : "count");
    entity.setDynamicProperty("sort_requested", true);
  } else if (slot === OUTPUT_MODE_SLOT) {
    entity.setDynamicProperty("output_mode", getOutputMode(entity) === "network" ? "inventory" : "network");
  } else if (slot === CRAFT_BUTTON_SLOT) {
    performCraftButtonAction(entity, inv);
  } else if (slot === REMOVE_RECIPE_SLOT) {
    const block = getEntityBlock(entity);
    if (!block) {
      entity.setDynamicProperty("is_processing_click", false);
      return;
    }
    const nodes = getConnectedInventories(block);
    for (let i of CRAFTING_GRID) {
      let item = inv.getItem(i);
      if (!item) continue;
      if (getStoredCount(item) !== -1) {
        inv.setItem(i, undefined);
        continue;
      }
      let remaining = addItemsToNetwork(nodes, item);
      if (remaining > 0) {
        item.amount = remaining;
        inv.setItem(i, item);
      } else {
        inv.setItem(i, undefined);
      }
    }
    inv.setItem(CRAFTING_BLUEPRINT_SLOT, undefined);
  }
  entity.setDynamicProperty("last_rendered_page", -1);
  entity.setDynamicProperty("force_refresh", true);
  scheduleCraftingTerminalRender(entity);
  system.runTimeout(() => {
    if (entity.isValid) entity.setDynamicProperty("is_processing_click", false);
  }, BUTTON_RELEASE_TICKS);
});
function getMachineEntity(block) {
  return block.dimension.getEntitiesAtBlockLocation(block.location).find((e) => e.typeId === "utilitycraft:crafting_terminal");
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
function getCraftSource(blueprint, inv, nodes) {
  const networkCrafts = nodes.networkId ? amountToCraftFromNetwork(blueprint, nodes, Number.MAX_SAFE_INTEGER) : 0;
  const gridCrafts = amountToCraftFromGrid(blueprint, inv);
  if (networkCrafts <= 0 && gridCrafts <= 0) return undefined;
  return networkCrafts >= gridCrafts
    ? { source: "network", maxCrafts: networkCrafts }
    : { source: "grid", maxCrafts: gridCrafts };
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
  if (toNetwork && nodes.networkId) {
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
function consumeCraftMaterials(block, inv, nodes, blueprint, source, crafts) {
  const recipe = getBlueprintRecipe(blueprint);
  if (!recipe || crafts <= 0) return false;
  if (source === "network") {
    for (const mat of recipe) {
      removeItemsFromNetwork(nodes, mat.id, mat.amount * crafts);
    }
  } else if (!consumeRecipeFromGrid(inv, recipe, crafts)) {
    return false;
  }

  const leftover = blueprint.getDynamicProperty("leftover") || false;
  if (leftover !== false) deliverRawItemAmount(block, nodes, leftover, crafts, Boolean(nodes.networkId));
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
  if (outputMode === "network" && !nodes.networkId) return false;

  const sourceData = getCraftSource(blueprint, inv, nodes);
  if (!sourceData) return false;

  const crafts = Math.min(getCraftQty(entity), sourceData.maxCrafts);
  if (crafts <= 0) return false;
  if (!consumeCraftMaterials(block, inv, nodes, blueprint, sourceData.source, crafts)) return false;

  deliverStoredItemAmount(block, nodes, result.id, result.amount * crafts, outputMode === "network");
  entity.setDynamicProperty("force_refresh", true);
  return true;
}
function hasBurnSlotItem(inv) {
  const burnItem = inv.getItem(BURN_SLOT);
  return Boolean(burnItem && burnItem.typeId !== "utilitycraft:storage_filler");
}
function hasActionableStorageItems(inv) {
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    const item = inv.getItem(i);
    if (!item || item.typeId === "utilitycraft:storage_filler") continue;
    if (getStoredCount(item) === -1 && !isStorageCell(item)) return true;
  }

  return false;
}
function hasVisibleVirtualStorageItems(inv) {
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    const item = inv.getItem(i);
    if (!item || item.typeId === "utilitycraft:storage_filler") continue;
    if (getStoredCount(item) !== -1) return true;
  }

  return false;
}
function shouldCheckStorageGrid(entity, currentTick) {
  const lastTick = Math.floor(Number(entity.getDynamicProperty("last_grid_repair_tick") ?? -GRID_REPAIR_TICKS));
  if (currentTick - lastTick < GRID_REPAIR_TICKS) return false;

  entity.setDynamicProperty("last_grid_repair_tick", currentTick);
  return true;
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
function setCountLabel(machine, inv, slot) {
  Terminal.setCountLabel(machine, inv, slot, {
    countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
  });
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
    countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
    loreDisplay: LORE_DISPLAY,
  });
}
function isRenderedItemVisible(entity, inv, itemKey) {
  return Terminal.isRenderedItemVisible(entity, inv, itemKey, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
  });
}
function applyNetworkDeltas(entity, inv, machine, networkRecord, networkId, currentQty) {
  return Terminal.applyNetworkDeltas(entity, inv, machine, networkRecord, networkId, currentQty, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
    countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
    loreDisplay: LORE_DISPLAY,
  });
}
function syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion) {
  Terminal.syncNetworkState(entity, networkRecord, networkTotals, networkVersion);
}
async function renderCraftingTerminalPage(
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
  renderCraftingTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);

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
    countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
    loreDisplay: LORE_DISPLAY,
    spreadTicks: PAGE_CHANGE_DELAY_TICKS,
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
  const inv = entity.getComponent("minecraft:inventory").container;
  Terminal.repairFillerSlots(inv, RESERVED_FILLER_SLOTS, {
    entity,
    onBlockedItem: (item) => returnToPlayer(block, item),
  });
  ButtonManager.ensureWatching(entity, "crafting_terminal");
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
  const shouldRepairGrid =
    !Terminal.isChunkedRenderActive(entity) &&
    shouldCheckStorageGrid(entity, currentTick);
  let gridNeedsRepair =
    shouldRepairGrid &&
    Terminal.storageGridNeedsRender(inv, {
      storageStart: STORAGE_START,
      storageEnd: STORAGE_END,
      countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
    });
  let pageChanged = false;
  let networkVersion = networkSnapshot.version;
  const lastNetworkVersion = entity.getDynamicProperty("last_network_version") ?? -1;
  const hasNetworkSnapshot = Boolean(networkSnapshot.networkId);
  const wasNetworkAvailable = entity.getDynamicProperty("last_network_available") === true;
  if (hasNetworkSnapshot !== wasNetworkAvailable) {
    forceRefresh = true;
    entity.setDynamicProperty("force_refresh", true);
    entity.setDynamicProperty("last_rendered_page", -1);
  }
  entity.setDynamicProperty("last_network_available", hasNetworkSnapshot);
  const hasRenderedNetworkItems = !hasNetworkSnapshot && (
    Object.keys(getRenderedSlotMap(entity)).length > 0 ||
    hasVisibleVirtualStorageItems(inv)
  );
  if (!hasNetworkSnapshot && (lastNetworkVersion !== 0 || hasRenderedNetworkItems)) {
    forceRefresh = true;
    entity.setDynamicProperty("force_refresh", true);
    entity.setDynamicProperty("last_rendered_page", -1);
  }
  const currentHash = getGridHash(inv);
  const lastHash = entity.getDynamicProperty("grid_hash");
  const isResolving = entity.getDynamicProperty("is_resolving_recipe");
  const shouldResolveGridRecipe = currentHash !== lastHash && !isResolving;
  const hasPendingBurnSlot = hasBurnSlotItem(inv);
  const stateBlueprintItem = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
  const hasCraftBlueprint = stateBlueprintItem && stateBlueprintItem.typeId === OUTPUT_BLUEPRINT_ITEM;
  const gridState = getSlotsStateHash(inv, CRAFTING_GRID);
  const blueprintState = getSlotStateHash(inv, CRAFTING_BLUEPRINT_SLOT);
  const outputState = getSlotStateHash(inv, OUTPUT_SLOT);
  const activityChanged =
    gridState !== (entity.getDynamicProperty("last_grid_state_hash") ?? "") ||
    blueprintState !== (entity.getDynamicProperty("last_blueprint_state_hash") ?? "") ||
    outputState !== (entity.getDynamicProperty("last_output_state_hash") ?? "");
  if (activityChanged) {
    syncActivityState(entity, gridState, blueprintState, outputState);
  }
  const shouldScanInput = forceRefresh || controlsChanged || hasPendingBurnSlot || currentTick % 10 === 0;
  const hasPendingInput = hasPendingBurnSlot || (shouldScanInput ? hasActionableStorageItems(inv) : false);
  const canUseNetworkDeltas =
    hasNetworkSnapshot &&
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
      renderCraftingTerminalPage(
        entity,
        inv,
        machine,
        fullSnapshot.networkId,
        Boolean(fullSnapshot.networkId),
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

  const fullSnapshot = readFullNetworkSnapshot(block, networkSnapshot.networkId);
  networkSnapshot.record = fullSnapshot.record;
  networkSnapshot.totals = fullSnapshot.totals;
  networkVersion = fullSnapshot.version;
  pageCount = getPageCountFromTotals(networkSnapshot.totals);
  currentPage = clampTerminalPage(entity, pageCount);

  if (
    currentPage !== lastRendered ||
    pageCount !== lastPageCount ||
    currentQty !== lastQty ||
    currentCraftQty !== lastCraftQty ||
    currentSort !== lastSort ||
    currentOutputMode !== lastOutputMode ||
    controlsChanged ||
    gridNeedsRepair
  ) {
    pageChanged = true;
    renderCraftingTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentCraftQty, currentSort);
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
  if (currentBurnItem && getStoredCount(currentBurnItem) !== -1) {
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
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    let item = inv.getItem(i);
    if (!item) continue;
    if (item.typeId === "utilitycraft:storage_filler") continue;
    if (getStoredCount(item) === -1 && !isStorageCell(item)) {
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
        if (isRenderedItemVisible(entity, inv, itemKey)) {
          updateVisibleVirtualItem(entity, inv, machine, nodes.networkId, itemKey, newCount, currentQty);
          syncTerminalNetworkState(entity, updatedNetwork, updatedTotals, updatedNetwork?.version ?? networkVersion);
          return;
        }
        syncTerminalNetworkState(entity, updatedNetwork, updatedTotals, updatedNetwork?.version ?? networkVersion);
        return;
      }
    }
  }
  for (let slot of CRAFTING_GRID) {
    let gItem = inv.getItem(slot);
    if (gItem && getStoredCount(gItem) !== -1) {
      let itemKey = getItemKey(gItem);
      inv.setItem(slot, undefined);
      let available = countItemsInNetwork(nodes, itemKey);
      let maxStack = createItemFromKey(itemKey, 1).maxAmount ?? 64;
      let take = Math.min(gItem.amount, maxStack, available);
      if (take > 0) {
        removeItemsFromNetwork(nodes, itemKey, take);
        let realItem = createItemFromKey(itemKey, take);
        inv.setItem(slot, realItem);
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
  }
  let blueprintItem = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
  let prevActive = entity.getDynamicProperty("preview_active") ?? false;
  if (shouldResolveGridRecipe) {
    entity.setDynamicProperty("grid_hash", currentHash);
    entity.setDynamicProperty("is_resolving_recipe", true);
    inv.setItem(CRAFTING_BLUEPRINT_SLOT, undefined);
    let gridItems = CRAFTING_GRID.map((s) => inv.getItem(s));
    resolveRecipeAsync(block.dimension, block.location, gridItems, entity);
    blueprintItem = undefined;
  }

  const blueprintResult =
    blueprintItem && !entity.getDynamicProperty("is_resolving_recipe") ? getBlueprintResult(blueprintItem) : undefined;
  if (blueprintResult) {
    const maxStack = createItemFromKey(blueprintResult.id, 1).maxAmount ?? 64;
    const displayAmount = Math.min(maxStack, blueprintResult.amount);
    const currentOutputItem = inv.getItem(OUTPUT_SLOT);
    if (
      !prevActive ||
      !currentOutputItem ||
      currentOutputItem.typeId === "utilitycraft:storage_filler" ||
      getItemKey(currentOutputItem) !== blueprintResult.id ||
      currentOutputItem.amount !== displayAmount
    ) {
      if (currentOutputItem && currentOutputItem.typeId !== "utilitycraft:storage_filler" && !prevActive) {
        returnToPlayer(block, currentOutputItem);
      }
      let previewItemStack = createItemFromKey(blueprintResult.id, displayAmount);
      previewItemStack.setLore(OUTPUT_PREVIEW_LORE);
      inv.setItem(OUTPUT_SLOT, previewItemStack);
      entity.setDynamicProperty("preview_active", true);
      entity.setDynamicProperty("preview_source", "static");
      entity.setDynamicProperty("preview_crafts", 0);
      entity.setDynamicProperty("preview_item_key", blueprintResult.id);
      entity.setDynamicProperty("preview_amount", displayAmount);
    }
  } else {
    if (prevActive) {
      inv.setItem(OUTPUT_SLOT, undefined);
      entity.setDynamicProperty("preview_active", false);
    }
    let checkOutput = inv.getItem(OUTPUT_SLOT);
    if (checkOutput && checkOutput.typeId !== "utilitycraft:storage_filler") {
      returnToPlayer(block, checkOutput);
      checkOutput = undefined;
    }
    if (!checkOutput || (checkOutput.typeId === "utilitycraft:storage_filler" && checkOutput.nameTag !== "§rOutput Slot")) {
      let filler = new ItemStack("utilitycraft:storage_filler", 1);
      filler.nameTag = "§rOutput Slot";
      inv.setItem(OUTPUT_SLOT, filler);
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
    renderCraftingTerminalPage(
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
DoriosAPI.register.blockComponent("crafting_terminal", {
  beforeOnPlayerPlace(e, { params: settings }) {
    Terminal.onPlace(e, settings, {
      entityType: "utilitycraft:crafting_terminal",
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
      let output = inv.getItem(OUTPUT_SLOT);
      let itemsToDrop = [];
      if (burnItem && getStoredCount(burnItem) === -1 && burnItem.typeId !== "utilitycraft:storage_filler") itemsToDrop.push(burnItem);
      let prevActive = entity.getDynamicProperty("preview_active");
      if (output && getStoredCount(output) === -1 && output.typeId !== "utilitycraft:storage_filler" && !prevActive) {
        itemsToDrop.push(output);
      }
      for (let slot of CRAFTING_GRID) {
        let gridItem = inv.getItem(slot);
        if (gridItem && getStoredCount(gridItem) === -1) itemsToDrop.push(gridItem);
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
