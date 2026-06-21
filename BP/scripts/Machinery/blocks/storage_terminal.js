// Imports

import { ItemStack, system } from "@minecraft/server";
import { ButtonManager } from "DoriosCore/index.js";
import { Terminal } from "Machinery/core/terminal.js";
import {
  getCellData,
  cellCapacities,
} from "Machinery/blocks/storage_cell_drive.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import {
  addToNetworkDetailed,
  readNetworkMeta,
  readNetworkRecord,
} from "Machinery/storage/storage_db.js";
import {
  applyVirtualLore,
} from "Machinery/storage/virtual_item_codec.js";

// Constant

const BURN_SLOT = 227;
const STORAGE_START = 0;
const STORAGE_END = 224;
const NEXT_SLOT = 228;
const PREVIOUS_SLOT = 229;
const QUANTITY_SLOT = 230;
const SORT_SLOT = 231;
const LORE_DISPLAY = "§r§7- Count: §f";
const MAX_PAGES = 27;
const STORAGE_SLOTS = 225;
const CONTROL_SLOTS = [PREVIOUS_SLOT, NEXT_SLOT, QUANTITY_SLOT, SORT_SLOT];
const RESERVED_FILLER_SLOTS = [225, 226];
const RENDER_SETTINGS = {
  machine: {
    rate_speed_base: 0,
  },
  ignoreTick: false,
};
const BURN_SLOT_TICKS = 2;
const BUTTON_RELEASE_TICKS = 6;

// Main Work (Functions)

function getEntityBlock(entity) {
  return Terminal.getEntityBlock(entity);
}
function renderStorageTerminalNow(entity) {
  try {
    if (!entity || !entity.isValid) return;
    const block = getEntityBlock(entity);
    if (!block) return;
    runStorageTerminalTick(block, entity, RENDER_SETTINGS);
  } catch (e) {
    console.warn("Storage terminal button render skipped.");
  }
}
function scheduleStorageTerminalRender(entity) {
  system.runTimeout(() => renderStorageTerminalNow(entity), 1);
}
function controlsNeedRender(inv) {
  return Terminal.controlsNeedRender(inv, CONTROL_SLOTS);
}
function renderTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentSort) {
  const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
  prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${pageCount}`;
  inv.setItem(PREVIOUS_SLOT, prevItem);
  const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
  nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${pageCount}`;
  inv.setItem(NEXT_SLOT, nextItem);
  const qtyItem = new ItemStack("utilitycraft:ui_filler", 1);
  qtyItem.nameTag = `§r§fx${currentQty}`;
  inv.setItem(QUANTITY_SLOT, qtyItem);
  const sortItem = new ItemStack("utilitycraft:ui_filler", 1);
  sortItem.nameTag = `§r§7- Sort By: §f${currentSort === "name" ? "Name" : "Count"}`;
  inv.setItem(SORT_SLOT, sortItem);
  entity.setDynamicProperty("last_rendered_page", currentPage);
  entity.setDynamicProperty("last_rendered_page_count", pageCount);
  entity.setDynamicProperty("last_rendered_qty", currentQty);
  entity.setDynamicProperty("last_rendered_sort", currentSort);
}
function initializeStorageTerminalInventory(entity) {
  const inv = entity.getComponent("minecraft:inventory")?.container;
  if (!inv) return false;

  for (let slot = STORAGE_START; slot <= STORAGE_END; slot++) {
    const item = inv.getItem(slot);
    if (!item || item.typeId === "utilitycraft:storage_filler") {
      inv.setItem(slot, Terminal.createStorageFiller(entity, slot));
    }
  }

  Terminal.repairFillerSlots(inv, RESERVED_FILLER_SLOTS, { entity });
  renderTerminalControls(entity, inv, 0, 1, 1, "count");
  return true;
}
function refreshStorageTerminalControls(entity) {
  try {
    if (!entity || !entity.isValid) return;
    const inv = entity.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    let currentPage = entity.getDynamicProperty("page") ?? 0;
    const pageCount = getPageCountForEntity(entity);
    currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));
    const currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
    const currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
    renderTerminalControls(
      entity,
      inv,
      currentPage,
      pageCount,
      currentQty,
      currentSort,
    );
  } catch (e) {}
}
function canChangePage(entity) {
  return Terminal.canChangePage(entity, Terminal.getPageChangeDelayTicks());
}
function markPageChanged(entity) {
  Terminal.markPageChanged(entity);
}
function setupStorageTerminalEntity(entity, block) {
  Terminal.setupBaseEntity(entity, block, {
    nameTag: "entity.utilitycraft:storage_terminal.name",
    machineId: "utilitycraft:storage_terminal",
    page: 0,
    pageChangeDelayTicks: Terminal.getPageChangeDelayTicks(),
    extraProperties: {
      rendered_order: "[]",
      rendered_storage_used_slots: 0,
      sort_requested: true,
    },
  });
  if (!initializeStorageTerminalInventory(entity)) {
    system.runTimeout(() => initializeStorageTerminalInventory(entity), 1);
  }
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
ButtonManager.registerMachineButton(
  "storage_terminal",
  CONTROL_SLOTS,
  ({ entity, slot }) => {
    if (!entity || !entity.isValid) return;
    if (Terminal.isChunkedRenderActive(entity)) {
      refreshStorageTerminalControls(entity);
      return;
    }
    if (entity.getDynamicProperty("is_processing_click")) {
      scheduleStorageTerminalRender(entity);
      return;
    }
    entity.setDynamicProperty("is_processing_click", true);
    let changed = false;
    let currentPage = entity.getDynamicProperty("page") ?? 0;
    const pageCount = getPageCountForEntity(entity);
    currentPage = clampTerminalPage(entity, pageCount);
    if (slot === PREVIOUS_SLOT) {
      if (currentPage > 0) {
        if (!canChangePage(entity)) {
          entity.setDynamicProperty("is_processing_click", false);
          scheduleStorageTerminalRender(entity);
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
          scheduleStorageTerminalRender(entity);
          return;
        }
        entity.setDynamicProperty("page", currentPage + 1);
        markPageChanged(entity);
        changed = true;
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
      changed = true;
    } else if (slot === SORT_SLOT) {
      let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
      entity.setDynamicProperty(
        "sort_mode",
        currentSort === "count" ? "name" : "count",
      );
      entity.setDynamicProperty("sort_requested", true);
      changed = true;
    }
    if (changed) scheduleStorageTerminalRender(entity);
    else refreshStorageTerminalControls(entity);
    system.runTimeout(() => {
      if (entity.isValid)
        entity.setDynamicProperty("is_processing_click", false);
    }, BUTTON_RELEASE_TICKS);
  },
);
function getMachineEntity(block) {
  return block.dimension
    .getEntitiesAtBlockLocation(block.location)
    .find((e) => e.typeId === "utilitycraft:storage_terminal");
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
function createLabelWriter(inv) {
  return {
    setLabel(text, slot = 1) {
      const baseItem = inv.getItem(slot) ?? new ItemStack("utilitycraft:arrow_indicator_90");
      baseItem.nameTag = text;
      inv.setItem(slot, baseItem);
    },
  };
}
function findVisibleVirtualSlot(inv, itemKey) {
  return Terminal.findVisibleVirtualSlot(inv, itemKey, {
    storageStart: STORAGE_START,
    storageEnd: STORAGE_END,
  });
}
function getRenderedSlotMap(entity) {
  return Terminal.getRenderedSlotMap(entity);
}
function setRenderedSlotMap(entity, pageSlice) {
  Terminal.setRenderedSlotMap(entity, pageSlice, STORAGE_START);
  entity.setDynamicProperty("rendered_storage_used_slots", Math.min(STORAGE_SLOTS, pageSlice.length));
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
  const keys = Object.keys(networkTotals).filter(
    (key) => (networkTotals[key] || 0) > 0,
  );
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
      if (!orderedSet.has(key)) {
        order.push(key);
      }
    }
  }

  entity.setDynamicProperty("rendered_order", JSON.stringify(order));
  return order;
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
function findFreeStorageSlot(entity, inv) {
  const expectedSlot = STORAGE_START + getRenderedStorageUsedSlots(entity);
  if (expectedSlot >= STORAGE_START && expectedSlot <= STORAGE_END) {
    const expectedItem = inv.getItem(expectedSlot);
    if (!expectedItem || expectedItem.typeId === "utilitycraft:storage_filler") return expectedSlot;
  }

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
function getRenderedStorageUsedSlots(entity) {
  const stored = entity.getDynamicProperty("rendered_storage_used_slots");
  if (typeof stored !== "number") {
    const slots = Object.values(getRenderedSlotMap(entity));
    const usedFromMap = slots.reduce((max, slot) => (
      Number.isInteger(slot) && slot >= STORAGE_START && slot <= STORAGE_END
        ? Math.max(max, slot - STORAGE_START + 1)
        : max
    ), 0);
    entity.setDynamicProperty("rendered_storage_used_slots", usedFromMap);
    return usedFromMap;
  }
  const used = Math.floor(Number(stored) || 0);
  return Math.max(0, Math.min(STORAGE_SLOTS, used));
}
function isActionableInputItem(item) {
  return !!item &&
    item.typeId !== "utilitycraft:storage_filler" &&
    !Terminal.isRenderedVirtualItem(item) &&
    !isStorageCell(item);
}
function getExpectedInputSlot(entity, inv) {
  const slot = STORAGE_START + getRenderedStorageUsedSlots(entity);
  if (slot < STORAGE_START || slot > STORAGE_END) return -1;
  return isActionableInputItem(inv.getItem(slot)) ? slot : -1;
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
  entity.setDynamicProperty(
    "rendered_storage_used_slots",
    Math.max(getRenderedStorageUsedSlots(entity), slot - STORAGE_START + 1),
  );
  appendRenderedOrder(entity, itemKey);
}
function updateOrAppendVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty) {
  const renderedSlots = getRenderedSlotMap(entity);
  if (Number.isInteger(renderedSlots[itemKey]) || isRenderedItemVisible(entity, inv, itemKey)) {
    return updateVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty);
  }

  if (count <= 0) return true;

  const freeSlot = findFreeStorageSlot(entity, inv);
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
      loreDisplay: LORE_DISPLAY,
      appendVisibleItem: (itemKey, count) =>
        updateOrAppendVisibleVirtualItem(entity, inv, machine, networkId, itemKey, count, currentQty),
    },
  );
}
function syncTerminalNetworkState(entity, networkRecord, networkTotals, networkVersion) {
  Terminal.syncNetworkState(entity, networkRecord, networkTotals, networkVersion);
}
function syncTerminalNetworkCursor(entity, version, changeSeq) {
  Terminal.syncNetworkCursor(entity, version, changeSeq);
}
function shouldProcessBurnSlot(entity) {
  const currentTick = system.currentTick ?? 0;
  const lastTick = Math.floor(Number(entity.getDynamicProperty("last_burn_slot_tick") ?? -BURN_SLOT_TICKS));
  if (currentTick - lastTick < BURN_SLOT_TICKS) return false;

  entity.setDynamicProperty("last_burn_slot_tick", currentTick);
  return true;
}
function syncAfterBurnSlotChange(entity, inv, machine, networkId, updatedNetwork, itemKey, currentQty) {
  const newCount = Number(updatedNetwork?.totals?.[itemKey] ?? 0);
  const handled = updateOrAppendVisibleVirtualItem(
    entity,
    inv,
    machine,
    networkId,
    itemKey,
    newCount,
    currentQty,
  );
  syncTerminalNetworkState(
    entity,
    updatedNetwork,
    updatedNetwork?.totals ?? {},
    updatedNetwork?.version ?? 0,
  );
  if (!handled) entity.setDynamicProperty("force_refresh", true);
}
function processStorageGridInput(block, entity, inv, machine, networkId, currentQty, networkVersion, changeSeq = 0, preferredSlot = -1) {
  const hasPreferredSlot = preferredSlot >= STORAGE_START && preferredSlot <= STORAGE_END;
  const start = hasPreferredSlot ? preferredSlot : STORAGE_START;
  const end = hasPreferredSlot ? preferredSlot : STORAGE_END;

  for (let i = start; i <= end; i++) {
    let item = inv.getItem(i);
    if (!isActionableInputItem(item)) continue;

    if (!networkId) {
      returnToPlayer(block, item);
      inv.setItem(i, undefined);
      return true;
    }

    const itemKey = getItemKey(item);
    const originalAmount = item.amount;
    const result = addToNetworkDetailed(networkId, itemKey, originalAmount);
    const remaining = result.remaining;
    if (remaining >= originalAmount) return true;

    inv.setItem(
      i,
      remaining > 0 ? createItemFromKey(itemKey, remaining) : undefined,
    );
    const handledVisibleUpdate = updateOrAppendVisibleVirtualItem(
      entity,
      inv,
      machine,
      networkId,
      itemKey,
      result.after,
      currentQty,
    );
    syncTerminalNetworkCursor(
      entity,
      result.version || networkVersion,
      result.changeSeq || changeSeq,
    );
    if (!handledVisibleUpdate) entity.setDynamicProperty("force_refresh", true);
    return true;
  }

  return false;
}
function processBurnSlotEvery2Ticks(block, entity) {
  if (!entity || !entity.isValid || entity.getDynamicProperty("is_proxy")) return;
  if (!shouldProcessBurnSlot(entity)) return;

  const inv = entity.getComponent("minecraft:inventory")?.container;
  if (!inv) return;

  let burnItem = inv.getItem(BURN_SLOT);
  if (!burnItem) return;

  if (burnItem.typeId === "utilitycraft:storage_filler") {
    inv.setItem(BURN_SLOT, undefined);
    return;
  }

  const nodes = getConnectedInventories(block);
  if (!nodes?.networkId) return;
  const network = readNetworkRecord(nodes.networkId);
  if (!network || network.online === false) return;

  const machine = createLabelWriter(inv);
  const currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
  const storedCount = getStoredCount(burnItem);

  if (storedCount !== -1) {
    const itemKey = getItemKey(burnItem);
    const take = Math.min(burnItem.maxAmount, countItemsInNetwork(nodes, itemKey));
    if (take <= 0) return;

    inv.setItem(BURN_SLOT, undefined);
    removeItemsFromNetwork(nodes, itemKey, take);
    returnToPlayer(block, createItemFromKey(itemKey, take));

    const updatedNetwork = readNetworkRecord(nodes.networkId);
    syncAfterBurnSlotChange(entity, inv, machine, nodes.networkId, updatedNetwork, itemKey, currentQty);
    return;
  }

  if (isStorageCell(burnItem)) return;

  const originalAmount = burnItem.amount;
  const itemKey = getItemKey(burnItem);
  const remaining = addItemsToNetwork(nodes, burnItem);
  if (remaining >= originalAmount) return;

  inv.setItem(
    BURN_SLOT,
    remaining === 0
      ? undefined
      : createItemFromKey(itemKey, remaining),
  );

  const updatedNetwork = readNetworkRecord(nodes.networkId);
  syncAfterBurnSlotChange(entity, inv, machine, nodes.networkId, updatedNetwork, itemKey, currentQty);
}
async function renderStorageTerminalPage(
  entity,
  inv,
  machine,
  networkId,
  hasNetwork,
  networkTotals,
  currentPage,
  pageCount,
  currentQty,
  currentSort,
) {
  renderTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentSort);

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
function runStorageTerminalTick(block, machineEntity, settings) {
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
  ButtonManager.ensureWatching(entity, "storage_terminal");
  const networkSnapshot = getNetworkSnapshot(block);
  let currentPage = entity.getDynamicProperty("page") ?? 0;
  let lastRendered = entity.getDynamicProperty("last_rendered_page") ?? -1;
  let lastPageCount = entity.getDynamicProperty("last_rendered_page_count") ?? -1;
  let pageCount = Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(lastPageCount)) || 1));
  currentPage = clampTerminalPage(entity, pageCount);
  let currentQty = entity.getDynamicProperty("extract_quantity") ?? 1;
  let lastQty = entity.getDynamicProperty("last_rendered_qty") ?? -1;
  let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
  let lastSort = entity.getDynamicProperty("last_rendered_sort") ?? "";
  let forceRefresh = entity.getDynamicProperty("force_refresh") ?? false;
  let controlsChanged = controlsNeedRender(inv);
  const currentTick = system.currentTick ?? 0;
  const gridNeedsRepair = false;
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
  const expectedInputSlot = getExpectedInputSlot(entity, inv);
  const hasPendingInput =
    expectedInputSlot >= 0 || (forceRefresh ? hasActionableStorageItems(inv) : false);
  const canUseNetworkDeltas =
    hasNetworkOnline &&
    !forceRefresh &&
    !controlsChanged &&
    !hasPendingInput &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentSort === lastSort &&
    networkVersion !== lastNetworkVersion;
  if (canUseNetworkDeltas) {
    const handledByDeltas = applyNetworkDeltas(
      entity,
      inv,
      machine,
      networkSnapshot.record,
      networkSnapshot.networkId,
      currentQty,
    );
    if (handledByDeltas === "reload") {
      const fullSnapshot = readFullNetworkSnapshot(block, networkSnapshot.networkId);
      const nextPageCount = getPageCountFromTotals(fullSnapshot.totals);
      const nextPage = Math.max(0, Math.min(currentPage, nextPageCount - 1));
      if (nextPage !== currentPage) entity.setDynamicProperty("page", nextPage);
      renderStorageTerminalPage(
        entity,
        inv,
        machine,
        fullSnapshot.networkId,
        Boolean(fullSnapshot.networkId && fullSnapshot.record?.online === true),
        fullSnapshot.totals,
        nextPage,
        nextPageCount,
        currentQty,
        currentSort,
      );
      syncTerminalNetworkState(
        entity,
        fullSnapshot.record,
        fullSnapshot.totals,
        fullSnapshot.version,
      );
      entity.setDynamicProperty("force_refresh", false);
      return;
    }
    if (handledByDeltas) {
      syncTerminalNetworkState(
        entity,
        networkSnapshot.record,
        undefined,
        networkVersion,
      );
      entity.setDynamicProperty("force_refresh", false);
      return;
    }
    syncTerminalNetworkState(
      entity,
      networkSnapshot.record,
      undefined,
      networkVersion,
    );
    return;
  }
  if (
    !forceRefresh &&
    !controlsChanged &&
    !gridNeedsRepair &&
    !hasPendingInput &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentSort === lastSort &&
    networkVersion === lastNetworkVersion
  ) {
    return;
  }
  if (
    controlsChanged &&
    !forceRefresh &&
    !gridNeedsRepair &&
    !hasPendingInput &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentSort === lastSort &&
    networkVersion === lastNetworkVersion
  ) {
    renderTerminalControls(entity, inv, currentPage, pageCount, currentQty, currentSort);
    return;
  }
  if (
    hasPendingInput &&
    hasNetworkOnline &&
    !forceRefresh &&
    !controlsChanged &&
    !gridNeedsRepair &&
    currentPage === lastRendered &&
    currentQty === lastQty &&
    currentSort === lastSort
  ) {
    processStorageGridInput(
      block,
      entity,
      inv,
      machine,
      networkSnapshot.networkId,
      currentQty,
      networkVersion,
      networkSnapshot.record?.changeSeq,
      expectedInputSlot,
    );
    return;
  }

  const fullSnapshot = readFullNetworkSnapshot(block, networkSnapshot.networkId);
  networkSnapshot.record = fullSnapshot.record;
  networkSnapshot.totals = fullSnapshot.totals;
  networkVersion = fullSnapshot.version;
  pageCount = getPageCountFromTotals(networkSnapshot.totals);
  currentPage = clampTerminalPage(entity, pageCount);

  let gridNeedsRender =
    currentPage !== lastRendered ||
    currentQty !== lastQty ||
    currentSort !== lastSort ||
    gridNeedsRepair;
  const controlsNeedUpdate = controlsChanged || gridNeedsRender || pageCount !== lastPageCount;
  if (controlsNeedUpdate) {
    const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
    prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${pageCount}`;
    inv.setItem(PREVIOUS_SLOT, prevItem);
    const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
    nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${pageCount}`;
    inv.setItem(NEXT_SLOT, nextItem);
    const qtyItem = new ItemStack("utilitycraft:ui_filler", 1);
    qtyItem.nameTag = `§r§fx${currentQty}`;
    inv.setItem(QUANTITY_SLOT, qtyItem);
    const sortItem = new ItemStack("utilitycraft:ui_filler", 1);
    sortItem.nameTag = `§r§7- Sort By: §f${currentSort === "name" ? "Name" : "Count"}`;
    inv.setItem(SORT_SLOT, sortItem);
    entity.setDynamicProperty("last_rendered_page", currentPage);
    entity.setDynamicProperty("last_rendered_page_count", pageCount);
    entity.setDynamicProperty("last_rendered_qty", currentQty);
    entity.setDynamicProperty("last_rendered_sort", currentSort);
  }
  let nodes = getConnectedInventories(block);
  let networkTotals = Object.assign({}, networkSnapshot.totals);
  let hasNetwork = nodes.length > 0;
  if (hasPendingInput) {
    processStorageGridInput(
      block,
      entity,
      inv,
      machine,
      nodes.networkId,
      currentQty,
      networkVersion,
      networkSnapshot.record?.changeSeq,
      expectedInputSlot,
    );
  }

  if (hasNetwork) {
    const latestNetwork = readNetworkRecord(nodes.networkId);
    if (latestNetwork) {
      networkSnapshot.record = latestNetwork;
      networkTotals = Object.assign({}, latestNetwork.totals ?? {});
      networkVersion = latestNetwork.version ?? networkVersion;
    }
  }
  const shouldRenderTerminal =
    forceRefresh ||
    gridNeedsRender;
  if (shouldRenderTerminal) {
    pageCount = getPageCountFromTotals(networkTotals);
    currentPage = clampTerminalPage(entity, pageCount);

    renderStorageTerminalPage(
      entity,
      inv,
      machine,
      nodes.networkId,
      hasNetwork,
      networkTotals,
      currentPage,
      pageCount,
      currentQty,
      currentSort,
    );
    syncTerminalNetworkState(entity, networkSnapshot.record, networkTotals, networkVersion);
    entity.setDynamicProperty("force_refresh", false);
    return;
  }
}
DoriosAPI.register.blockComponent("storage_terminal", {
  beforeOnPlayerPlace(e, { params: settings }) {
    Terminal.onPlace(e, settings, {
      entityType: "utilitycraft:storage_terminal",
      setupEntity: setupStorageTerminalEntity,
    });
  },
  onTick(e, { params: settings }) {
    const { block } = e;
    const machineEntity = getMachineEntity(block);
    if (!machineEntity || !machineEntity.isValid) return;
    processBurnSlotEvery2Ticks(block, machineEntity);
    runStorageTerminalTick(block, machineEntity, settings);
  },
  onPlayerBreak(e) {
    const { block, dimension } = e;
    updateNetworkAround(block);
    const entity = getMachineEntity(block);
    if (entity && entity.isValid) {
      const inv =
        entity.getComponent("minecraft:inventory")?.container;
      if (inv) {
        let burnItem = inv.getItem(BURN_SLOT);
        let itemToDrop =
          burnItem && getStoredCount(burnItem) === -1 ? burnItem : null;
        inv.clearAll();
        if (itemToDrop && itemToDrop.typeId !== "utilitycraft:storage_filler") {
          dimension.spawnItem(itemToDrop, block.center());
        }
      }
      entity.triggerEvent("despawn");
    }
    Terminal.onDestroy(e);
  },
});
