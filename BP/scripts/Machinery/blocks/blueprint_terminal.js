// Imports

import { ItemStack, system } from "@minecraft/server";
import { ButtonManager } from "DoriosCore/index.js";
import { Terminal } from "Machinery/core/terminal.js";
import {
  getCellData,
  cellCapacities,
} from "Machinery/blocks/disk_drive.js";
import { updateNetworkAround } from "Machinery/storage/network_manager.js";
import {
  readNetworkRecord,
} from "Machinery/storage/storage_db.js";
import {
  applyVirtualLore,
  needsVirtualLoreRewrite,
} from "Machinery/storage/virtual_item_codec.js";

// Constant

const BURN_SLOT = 220;
const STORAGE_START = 0;
const STORAGE_END = 109;
const COUNT_LABEL_BASE_SLOT = 110;
const NEXT_SLOT = 221;
const PREVIOUS_SLOT = 222;
const QUANTITY_SLOT = 223;
const CRAFT_QTY_SLOT = 224;
const SORT_SLOT = 225;
const CRAFTING_BLUEPRINT_SLOT = 226;
const CRAFTING_OUTPUT_SLOT = 227;
const CRAFTING_INFO_PANEL_SLOT = 228;
const STORAGE_SLOTS = 110;
const LORE_DISPLAY = "§r§7- Count: §f";
const MAX_PAGES = 3;
const OUTPUT_BLUEPRINT_ITEM = "utilitycraft:blueprint";
const LOCAL_GRID_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const CONTROL_SLOTS = [
  PREVIOUS_SLOT,
  NEXT_SLOT,
  QUANTITY_SLOT,
  CRAFT_QTY_SLOT,
  SORT_SLOT,
];
const RENDER_SETTINGS = {
  machine: {
    rate_speed_base: 0,
  },
  ignoreTick: false,
};
const BUTTON_RELEASE_TICKS = 6;
const PAGE_CHANGE_DELAY_TICKS = 4;

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
function amountToCraftFromGrid(
  blueprint,
  container,
  gridSlots,
  maxCraftAmount,
) {
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
        container.setItem(
          slot,
          createItemFromKey(itemKey, item.amount - remaining),
        );
        remaining = 0;
        break;
      }
    }
  }
}
function updateTerminalInfo(machine, infoSlot, warning, status) {
  let text = `\n§r§bCrafting Info:\n`;
  text += `§r§7- Warning:\n`;
  if (warning) {
    text += `§r  §7-§c ${warning}\n`;
  } else {
    text += `§r  §7-§a None\n`;
  }
  text += `§r§7- Status:\n`;
  text += `§r  §7-§a ${status}`;
  machine.setLabel(text, infoSlot);
}
function setupCraftingTerminalEntity(entity, block) {
  Terminal.setupBaseEntity(entity, block, {
    nameTag: "entity.utilitycraft:blueprint_terminal.name",
    machineId: "utilitycraft:blueprint_terminal",
    page: -1,
    pageChangeDelayTicks: PAGE_CHANGE_DELAY_TICKS,
    extraProperties: {
      craft_qty: 1,
      output_mode: "default",
      grid_hash: "",
      is_resolving_recipe: false,
      output_filled: false,
      preview_amount: 0,
      preview_item_key: "",
    },
  });
}
ButtonManager.registerMachineButton(
  "blueprint_terminal",
  CONTROL_SLOTS,
  ({ entity, slot }) => {
    if (!entity || !entity.isValid) return;
    if (entity.getDynamicProperty("is_processing_click")) {
      scheduleBlueprintTerminalRender(entity);
      return;
    }
    entity.setDynamicProperty("is_processing_click", true);
    entity.setDynamicProperty("force_refresh", true);
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
      }
    } else if (slot === QUANTITY_SLOT) {
      let currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
      let nextQty =
        currentQty === 1
          ? 16
          : currentQty === 16
            ? 32
            : currentQty === 32
              ? 64
              : 1;
      entity.setDynamicProperty("extract_quantity", nextQty);
    } else if (slot === CRAFT_QTY_SLOT) {
      let cq = entity.getDynamicProperty("craft_qty") ?? 1;
      let nextCq = cq === 1 ? 2 : cq === 2 ? 4 : cq === 4 ? 6 : 1;
      entity.setDynamicProperty("craft_qty", nextCq);
    } else if (slot === SORT_SLOT) {
      let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
      entity.setDynamicProperty(
        "sort_mode",
        currentSort === "count" ? "name" : "count",
      );
    }
    entity.setDynamicProperty("last_rendered_page", -1);
    entity.setDynamicProperty("force_refresh", true);
    scheduleBlueprintTerminalRender(entity);
    system.runTimeout(() => {
      if (entity.isValid)
        entity.setDynamicProperty("is_processing_click", false);
    }, BUTTON_RELEASE_TICKS);
  },
);
function getMachineEntity(block) {
  return block.dimension
    .getEntitiesAtBlockLocation(block.location)
    .find((e) => e.typeId === "utilitycraft:blueprint_terminal");
}
function getConnectedInventories(startBlock) {
  return Terminal.getConnectedInventories(startBlock);
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
function findVisibleVirtualSlot(inv, itemKey) {
  return Terminal.findVisibleVirtualSlot(inv, itemKey, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
  });
}
function updateVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty) {
  return Terminal.updateVisibleVirtualItem(
    entity,
    inv,
    machine,
    networkId,
    itemKey,
    count,
    currentQty,
    {
      storageStart: STORAGE_START,
      storageEnd: STORAGE_END,
      countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
      loreDisplay: LORE_DISPLAY,
    },
  );
}
function isRenderedItemVisible(entity, inv, itemKey) {
  return Terminal.isRenderedItemVisible(entity, inv, itemKey, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
  });
}
function applyNetworkDeltas(entity, inv, machine, networkRecord, networkId, currentQty) {
  return Terminal.applyNetworkDeltas(
    entity,
    inv,
    machine,
    networkRecord,
    networkId,
    currentQty,
    {
      storageStart: STORAGE_START,
      storageEnd: STORAGE_END,
      countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
      loreDisplay: LORE_DISPLAY,
    },
  );
}
function syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion) {
  Terminal.syncNetworkState(entity, networkRecord, networkTotals, networkVersion);
}
function runCraftingStorageTerminalTick(block, machineEntity, settings) {
  const entity = machineEntity;
  const isProxy = entity.getDynamicProperty("is_proxy");
  if (isProxy) return;
  if (!entity || !entity.isValid) return;
  const machine = new Terminal(block, settings);
  if (!machine || !machine.valid) return;
  const inv = entity.getComponent("minecraft:inventory").container;
  ButtonManager.ensureWatching(entity, "blueprint_terminal");
  let currentPage = entity.getDynamicProperty("page") ?? 0;
  let lastRendered = entity.getDynamicProperty("last_rendered_page") ?? -1;
  let pageCount = getPageCountForEntity(entity);
  currentPage = clampTerminalPage(entity, pageCount);
  let lastPageCount = entity.getDynamicProperty("last_rendered_page_count") ?? -1;
  let currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
  let currentCraftQty = entity.getDynamicProperty("craft_qty") ?? 1;
  let lastQty = entity.getDynamicProperty("last_rendered_qty") ?? -1;
  let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
  let lastSort = entity.getDynamicProperty("last_rendered_sort") ?? "";
  let forceRefresh = entity.getDynamicProperty("force_refresh") ?? false;
  let controlsChanged = controlsNeedRender(inv);
  let pageChanged = false;
  if (
    currentPage !== lastRendered ||
    pageCount !== lastPageCount ||
    currentQty !== lastQty ||
    currentSort !== lastSort ||
    controlsChanged
  ) {
    pageChanged = true;
    const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
    prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${pageCount}`;
    inv.setItem(PREVIOUS_SLOT, prevItem);
    const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
    nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${pageCount}`;
    inv.setItem(NEXT_SLOT, nextItem);
    const qtyItem = new ItemStack("utilitycraft:ui_filler", 1);
    qtyItem.nameTag = `§r§7- Quantity: §f${currentQty}`;
    inv.setItem(QUANTITY_SLOT, qtyItem);
    const craftQtyItem = new ItemStack("utilitycraft:ui_filler", 1);
    craftQtyItem.nameTag = `§r§7- Craft Multiplier: §fx${currentCraftQty}`;
    inv.setItem(CRAFT_QTY_SLOT, craftQtyItem);
    const sortItem = new ItemStack("utilitycraft:ui_filler", 1);
    sortItem.nameTag = `§r§7- Sort By: §f${currentSort === "name" ? "Name" : "Count"}`;
    inv.setItem(SORT_SLOT, sortItem);
    entity.setDynamicProperty("last_rendered_page", currentPage);
    entity.setDynamicProperty("last_rendered_page_count", pageCount);
    entity.setDynamicProperty("last_rendered_qty", currentQty);
    entity.setDynamicProperty("last_rendered_sort", currentSort);
  }
  let nodes = getConnectedInventories(block);
  let networkRecord = readNetworkRecord(nodes.networkId);
  let networkTotals = Object.assign({}, networkRecord?.totals ?? {});
  let networkVersion = networkRecord?.version ?? 0;
  let lastNetworkVersion = entity.getDynamicProperty("last_network_version") ?? -1;
  let hasNetwork = nodes.length > 0;
  let currentBurnItem = inv.getItem(BURN_SLOT);
  if (
    currentBurnItem &&
    currentBurnItem.typeId === "utilitycraft:storage_filler"
  ) {
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
        updateVisibleVirtualItem(
          entity,
          inv,
          machine,
          nodes.networkId,
          itemKey,
          newCount,
          currentQty,
        );
        syncTerminalNetworkState(
          entity,
          updatedNetwork,
          updatedTotals,
          updatedNetwork?.version ?? networkVersion,
        );
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
      } else if (
        getItemKey(burnItem) === getItemKey(item) &&
        burnItem.amount < burnItem.maxAmount
      ) {
        let space = burnItem.maxAmount - burnItem.amount;
        let transfer = Math.min(space, item.amount);
        let combinedItem = createItemFromKey(
          getItemKey(burnItem),
          burnItem.amount + transfer,
        );
        inv.setItem(BURN_SLOT, combinedItem);
        let leftover = item.amount - transfer;
        if (leftover > 0)
          returnToPlayer(block, createItemFromKey(getItemKey(item), leftover));
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
        inv.setItem(
          BURN_SLOT,
          remaining === 0
            ? undefined
            : createItemFromKey(itemKey, remaining),
        );
        const updatedNetwork = readNetworkRecord(nodes.networkId);
        const updatedTotals = updatedNetwork?.totals ?? {};
        const newCount = Number(updatedTotals[itemKey] ?? 0);
        if (isRenderedItemVisible(entity, inv, itemKey)) {
          updateVisibleVirtualItem(
            entity,
            inv,
            machine,
            nodes.networkId,
            itemKey,
            newCount,
            currentQty,
          );
          syncTerminalNetworkState(
            entity,
            updatedNetwork,
            updatedTotals,
            updatedNetwork?.version ?? networkVersion,
          );
          return;
        }
        syncTerminalNetworkState(
          entity,
          updatedNetwork,
          updatedTotals,
          updatedNetwork?.version ?? networkVersion,
        );
        return;
      }
    }
  }
  let blueprintItem = inv.getItem(CRAFTING_BLUEPRINT_SLOT);
  if (blueprintItem && getStoredCount(blueprintItem) !== -1) {
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
        updateVisibleVirtualItem(
          entity,
          inv,
          machine,
          nodes.networkId,
          itemKey,
          newCount,
          currentQty,
        );
        syncTerminalNetworkState(
          entity,
          updatedNetwork,
          updatedTotals,
          updatedNetwork?.version ?? networkVersion,
        );
      }
    }
  }
  let previewActive = false;
  const maxCrafts = currentCraftQty;
  let resultItem, resultAmount, recipeStr;
  if (!blueprintItem || blueprintItem?.typeId !== OUTPUT_BLUEPRINT_ITEM) {
    updateTerminalInfo(
      machine,
      CRAFTING_INFO_PANEL_SLOT,
      "No Blueprint",
      "Idle",
    );
  } else {
    resultItem = blueprintItem.getDynamicProperty("id");
    resultAmount = blueprintItem.getDynamicProperty("amount");
    recipeStr = blueprintItem.getDynamicProperty("materials");
    if (
      resultItem === undefined ||
      resultAmount === undefined ||
      recipeStr === undefined
    ) {
      updateTerminalInfo(
        machine,
        CRAFTING_INFO_PANEL_SLOT,
        "Invalid Blueprint",
        "Idle",
      );
    } else {
      let canCraftNetwork = hasNetwork
        ? amountToCraftFromNetwork(blueprintItem, nodes, 1)
        : 0;
      let canCraftGrid = amountToCraftFromGrid(
        blueprintItem,
        inv,
        LOCAL_GRID_SLOTS,
        1,
      );
      if (canCraftNetwork <= 0 && canCraftGrid <= 0) {
        updateTerminalInfo(
          machine,
          CRAFTING_INFO_PANEL_SLOT,
          "Missing Items",
          "Idle",
        );
      } else {
        previewActive = true;
        let statusText =
          canCraftNetwork > 0 ? "Preview Ready" : "Preview Ready (Grid)";
        updateTerminalInfo(machine, CRAFTING_INFO_PANEL_SLOT, null, statusText);
      }
    }
  }
  let prevActive = entity.getDynamicProperty("output_filled") ?? false;
  let prevAmount = entity.getDynamicProperty("preview_amount") ?? 0;
  let prevKey = entity.getDynamicProperty("preview_item_key") ?? "";
  let existingOutput = inv.getItem(CRAFTING_OUTPUT_SLOT);
  if (prevActive) {
    let outputChanged = false;
    let blueprintMissing =
      !blueprintItem || blueprintItem.typeId !== OUTPUT_BLUEPRINT_ITEM;
    if (blueprintMissing) {
      outputChanged = true;
    } else if (!existingOutput) {
      outputChanged = true;
    } else if (existingOutput.typeId === "utilitycraft:storage_filler") {
      outputChanged = true;
    } else if (getItemKey(existingOutput) !== prevKey) {
      outputChanged = true;
    } else if (existingOutput.amount < prevAmount) {
      outputChanged = true;
    }
    if (outputChanged) {
      let itemTaken =
        !existingOutput ||
        existingOutput.typeId === "utilitycraft:storage_filler" ||
        getItemKey(existingOutput) !== prevKey ||
        existingOutput.amount < prevAmount;
      let validCraft = !blueprintMissing && itemTaken;
      if (validCraft) {
        let canCraftAmount = hasNetwork
          ? amountToCraftFromNetwork(blueprintItem, nodes, maxCrafts)
          : 0;
        let usedNetwork = true;
        if (canCraftAmount <= 0) {
          canCraftAmount = amountToCraftFromGrid(
            blueprintItem,
            inv,
            LOCAL_GRID_SLOTS,
            maxCrafts,
          );
          usedNetwork = false;
        }
        if (canCraftAmount > 0) {
          const recipe = JSON.parse(recipeStr);
          const leftover =
            blueprintItem.getDynamicProperty("leftover") || false;
          for (const mat of recipe) {
            if (usedNetwork) {
              removeItemsFromNetwork(
                nodes,
                mat.id,
                mat.amount * canCraftAmount,
              );
            } else {
              removeItemsFromGrid(
                inv,
                LOCAL_GRID_SLOTS,
                mat.id,
                mat.amount * canCraftAmount,
              );
            }
          }
          if (leftover !== false) {
            if (usedNetwork)
              addItemsToNetwork(nodes, new ItemStack(leftover, canCraftAmount));
            else {
              const nearestPlayer = block.dimension.getPlayers({
                location: block.location,
                maxDistance: 6,
              })[0];
              const pInv = nearestPlayer?.getComponent("inventory")?.container;
              pInv?.addItem(new ItemStack(leftover, canCraftAmount));
            }
          }
        }
      }
      if (
        existingOutput &&
        existingOutput.typeId !== "utilitycraft:storage_filler"
      ) {
        let isUntouchedPreview =
          getItemKey(existingOutput) === prevKey &&
          existingOutput.amount === prevAmount;
        if (!validCraft && isUntouchedPreview) {
        } else {
          returnToPlayer(block, existingOutput);
        }
        inv.setItem(CRAFTING_OUTPUT_SLOT, undefined);
      }
      entity.setDynamicProperty("output_filled", false);
      entity.setDynamicProperty("force_refresh", true);
      pageChanged = true;
      prevActive = false;
      existingOutput = undefined;
    }
  }
  if (previewActive) {
    let canCraftAmount = hasNetwork
      ? amountToCraftFromNetwork(blueprintItem, nodes, maxCrafts)
      : 0;
    if (canCraftAmount <= 0) {
      canCraftAmount = amountToCraftFromGrid(
        blueprintItem,
        inv,
        LOCAL_GRID_SLOTS,
        maxCrafts,
      );
    }
    let displayAmount = Math.min(
      64,
      resultAmount * Math.max(1, canCraftAmount),
    );
    existingOutput = inv.getItem(CRAFTING_OUTPUT_SLOT);
    let isCorrectPreview = false;
    if (existingOutput) {
      if (
        prevActive &&
        getItemKey(existingOutput) === resultItem &&
        existingOutput.amount === displayAmount
      ) {
        isCorrectPreview = true;
      } else {
        if (existingOutput.typeId !== "utilitycraft:storage_filler") {
          returnToPlayer(block, existingOutput);
        }
        inv.setItem(CRAFTING_OUTPUT_SLOT, undefined);
      }
    }
    if (!isCorrectPreview) {
      let previewItem = createItemFromKey(resultItem, displayAmount);
      inv.setItem(CRAFTING_OUTPUT_SLOT, previewItem);
      entity.setDynamicProperty("output_filled", true);
      entity.setDynamicProperty("preview_amount", displayAmount);
      entity.setDynamicProperty("preview_item_key", resultItem);
    }
  } else {
    if (prevActive) {
      inv.setItem(CRAFTING_OUTPUT_SLOT, undefined);
      entity.setDynamicProperty("output_filled", false);
    }
    let checkOutput = inv.getItem(CRAFTING_OUTPUT_SLOT);
    if (
      !checkOutput ||
      (checkOutput.typeId === "utilitycraft:storage_filler" &&
        checkOutput.nameTag !== "§rOutput Slot")
    ) {
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
    currentSort === lastSort &&
    networkVersion !== lastNetworkVersion
  ) {
    const handledByDeltas = applyNetworkDeltas(
      entity,
      inv,
      machine,
      networkRecord,
      nodes.networkId,
      currentQty,
    );
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
          prevItem.nameTag = `Â§rÂ§7- Previous Page Â§f${currentPage + 1}/${nextPageCount}`;
          inv.setItem(PREVIOUS_SLOT, prevItem);
          const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
          nextItem.nameTag = `Â§rÂ§7- Next Page Â§f${currentPage + 1}/${nextPageCount}`;
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

  if (hasNetwork && Object.keys(networkTotals).length === 0) {
    for (let node of nodes) {
      if (node.isDrive) {
        for (let i = 1; i <= 9; i++) {
          let data = getCellData(node.container.getItem(i));
          if (data) {
            for (let key in data.items)
              networkTotals[key] = (networkTotals[key] || 0) + data.items[key];
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
  }
  let sortedTypes = [];
  if (hasNetwork) {
    sortedTypes = Object.keys(networkTotals).sort((a, b) => {
      if (currentSort === "name") {
        let nameA = a.split("||")[0].split(":").pop();
        let nameB = b.split("||")[0].split(":").pop();
        return nameA.localeCompare(nameB);
      } else {
        return networkTotals[b] - networkTotals[a];
      }
    });
  }
  pageCount = getPageCountFromTotals(networkTotals);
  currentPage = clampTerminalPage(entity, pageCount);
  const itemsPerPage = STORAGE_SLOTS;
  const startIdx = currentPage * itemsPerPage;
  let pageSlice = sortedTypes.slice(startIdx, startIdx + itemsPerPage);
  setRenderedSlotMap(entity, pageSlice);
  let uiMismatch = false;
  for (let i = 0; i < itemsPerPage; i++) {
    let currentSlot = STORAGE_START + i;
    let existingItem = inv.getItem(currentSlot);
    let isFiller =
      existingItem && existingItem.typeId === "utilitycraft:storage_filler";
    let checkItem = isFiller ? undefined : existingItem;
    if (checkItem && getStoredCount(checkItem) === -1) continue;
    let expectedKey = pageSlice[i];
    if (expectedKey) {
      if (isFiller) {
        uiMismatch = true;
        break;
      }
      if (checkItem) {
        let existingKey = getItemKey(checkItem);
        let virtualItemTest = createItemFromKey(expectedKey, 1);
        let maxStack = virtualItemTest.maxAmount ?? 64;
        let expectedAmount = Math.min(
          currentQty,
          networkTotals[expectedKey] || 0,
          maxStack,
        );
        if (
          existingKey !== expectedKey ||
          getStoredCount(checkItem) !== networkTotals[expectedKey] ||
          checkItem.amount !== expectedAmount
        ) {
          uiMismatch = true;
          break;
        }
      } else {
        uiMismatch = true;
        break;
      }
    } else {
      if (!isFiller) {
        uiMismatch = true;
        break;
      }
    }
  }
  let currentNetworkState = JSON.stringify(networkTotals);
  let lastNetworkState = entity.getDynamicProperty("last_network_state");
  if (
    forceRefresh ||
    currentNetworkState !== lastNetworkState ||
    pageChanged ||
    uiMismatch
  ) {
    entity.setDynamicProperty("last_network_state", currentNetworkState);
    syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion);
    entity.setDynamicProperty("force_refresh", false);
    if (hasNetwork) {
      for (let i = 0; i < itemsPerPage; i++) {
        let currentSlot = STORAGE_START + i;
        let existingItem = inv.getItem(currentSlot);
        if (
          existingItem &&
          existingItem.typeId !== "utilitycraft:storage_filler" &&
          getStoredCount(existingItem) === -1
        )
          continue;
        if (i < pageSlice.length) {
          let key = pageSlice[i];
          let virtualItemTest = createItemFromKey(key, 1);
          let maxStack = virtualItemTest.maxAmount ?? 64;
          let renderAmount = Math.min(
            currentQty,
            networkTotals[key] || 0,
            maxStack,
          );
          let virtualItem = createItemFromKey(key, renderAmount);
          let currentLore = virtualItem.getLore() || [];
          applyVirtualLore(
            virtualItem,
            [...currentLore, `${LORE_DISPLAY}${networkTotals[key]}`],
            nodes.networkId,
            key,
          );
          let existingKey = existingItem ? getItemKey(existingItem) : null;
          if (
            !existingItem ||
            existingKey !== key ||
            getStoredCount(existingItem) !== networkTotals[key] ||
            existingItem.amount !== renderAmount ||
            needsVirtualLoreRewrite(existingItem)
          ) {
            inv.setItem(currentSlot, virtualItem);
          }
        } else {
          if (
            !existingItem ||
            existingItem.typeId !== "utilitycraft:storage_filler" ||
            existingItem.nameTag !== "§rStorage Slot"
          ) {
            let filler = new ItemStack("utilitycraft:storage_filler", 1);
            filler.nameTag = "§rStorage Slot";
            inv.setItem(currentSlot, filler);
          }
        }
      }
    } else {
      for (let i = STORAGE_START; i <= STORAGE_END; i++) {
        let item = inv.getItem(i);
        if (
          !item ||
          item.typeId !== "utilitycraft:storage_filler" ||
          item.nameTag !== "§rStorage Slot"
        ) {
          let filler = new ItemStack("utilitycraft:storage_filler", 1);
          filler.nameTag = "§rStorage Slot";
          inv.setItem(i, filler);
        }
      }
    }
  }
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    let labelSlot = COUNT_LABEL_BASE_SLOT + i;
    const item = inv.getItem(i);
    let labelText = " ";
    if (item && item.typeId !== "utilitycraft:storage_filler") {
      const count = getStoredCount(item);
      const valStr = (count !== -1 ? count : item.amount).toString();
      if (valStr !== "1") labelText = `§r§f${valStr}`;
    }
    machine.setLabel(labelText, labelSlot);
  }
}
function resolveRecipeAsync(dimension, location, gridItems, entity) {
  const minY =
    DoriosAPI.constants.dimensions[dimension.id.split(":")[1] || "overworld"]
      ?.minY ?? 0;
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
      dimension.runCommand(
        `replaceitem block ${x} ${minY} ${z} slot.container ${i} ${item.typeId}`,
      );
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
        ...recipeData.map(
          (m) => `\u00A7r\u00A77 - ${formatItemId(m.id)} x${m.amount}`,
        ),
      ]);
      inv.setItem(CRAFTING_BLUEPRINT_SLOT, newBlueprint);
    } else {
      inv.setItem(CRAFTING_BLUEPRINT_SLOT, undefined);
    }
    for (let slot = 0; slot < 9; slot++) {
      dimension.runCommand(
        `replaceitem block ${x} ${minY} ${z} slot.container ${slot} air`,
      );
    }
    dimension.setBlockType(
      { x, y: minY, z },
      crafterBlockId || "minecraft:bedrock",
    );
    dimension.setBlockType(
      { x, y: minY + 1, z },
      redstoneBlockId || "minecraft:bedrock",
    );
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
      if (burnItem && getStoredCount(burnItem) === -1)
        itemsToDrop.push(burnItem);
      if (blueprint) itemsToDrop.push(blueprint);
      let prevActive = entity.getDynamicProperty("output_filled");
      if (
        output &&
        getStoredCount(output) === -1 &&
        output.typeId !== "utilitycraft:storage_filler" &&
        !prevActive
      ) {
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
