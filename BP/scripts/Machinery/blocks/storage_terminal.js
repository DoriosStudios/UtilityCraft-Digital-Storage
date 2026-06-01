// Imports

import { ItemStack, system } from "@minecraft/server";
import { ButtonManager } from "DoriosCore/index.js";
import { Terminal } from "Machinery/core/terminal.js";
import {
  getCellData,
  cellCapacities,
} from "Machinery/blocks/disk_drive.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import {
  readNetworkMeta,
  readNetworkRecord,
} from "Machinery/storage/storage_db.js";
import {
  applyVirtualLore,
  needsVirtualLoreRewrite,
} from "Machinery/storage/virtual_item_codec.js";

// Constant

const BURN_SLOT = 218;
const STORAGE_START = 0;
const STORAGE_END = 107;
const COUNT_LABEL_BASE_SLOT = 108;
const NEXT_SLOT = 219;
const PREVIOUS_SLOT = 220;
const QUANTITY_SLOT = 221;
const SORT_SLOT = 222;
const LORE_DISPLAY = "§r§7- Count: §f";
const MAX_PAGES = 27;
const STORAGE_SLOTS = 108;
const CONTROL_SLOTS = [PREVIOUS_SLOT, NEXT_SLOT, QUANTITY_SLOT, SORT_SLOT];
const RESERVED_FILLER_SLOTS = [216, 217];
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
  qtyItem.nameTag = `§r§7- Quantity: §f${currentQty}`;
  inv.setItem(QUANTITY_SLOT, qtyItem);
  const sortItem = new ItemStack("utilitycraft:ui_filler", 1);
  sortItem.nameTag = `§r§7- Sort By: §f${currentSort === "name" ? "Name" : "Count"}`;
  inv.setItem(SORT_SLOT, sortItem);
  entity.setDynamicProperty("last_rendered_page", currentPage);
  entity.setDynamicProperty("last_rendered_page_count", pageCount);
  entity.setDynamicProperty("last_rendered_qty", currentQty);
  entity.setDynamicProperty("last_rendered_sort", currentSort);
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
  return Terminal.canChangePage(entity, PAGE_CHANGE_DELAY_TICKS);
}
function markPageChanged(entity) {
  Terminal.markPageChanged(entity);
}
function setupStorageTerminalEntity(entity, block) {
  Terminal.setupBaseEntity(entity, block, {
    nameTag: "entity.utilitycraft:storage_terminal.name",
    machineId: "utilitycraft:storage_terminal",
    page: 0,
    pageChangeDelayTicks: PAGE_CHANGE_DELAY_TICKS,
    extraProperties: {
      rendered_order: "[]",
      sort_requested: true,
    },
  });
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
    entity.setDynamicProperty("force_refresh", true);
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
    } else if (slot === SORT_SLOT) {
      let currentSort = entity.getDynamicProperty("sort_mode") ?? "count";
      entity.setDynamicProperty(
        "sort_mode",
        currentSort === "count" ? "name" : "count",
      );
      entity.setDynamicProperty("sort_requested", true);
    }
    entity.setDynamicProperty("last_rendered_page", -1);
    entity.setDynamicProperty("force_refresh", true);
    scheduleStorageTerminalRender(entity);
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
function hasBurnSlotItem(inv) {
  const burnItem = inv.getItem(BURN_SLOT);
  if (burnItem && burnItem.typeId !== "utilitycraft:storage_filler") {
    return true;
  }

  return false;
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
    countLabelBaseSlot: COUNT_LABEL_BASE_SLOT,
    loreDisplay: LORE_DISPLAY,
    spreadTicks: PAGE_CHANGE_DELAY_TICKS,
  });
}
function runStorageTerminalTick(block, machineEntity, settings) {
  const entity = machineEntity;
  const isProxy = entity.getDynamicProperty("is_proxy");
  if (isProxy) return;
  if (!entity || !entity.isValid) return;
  const machine = new Terminal(block, settings);
  if (!machine || !machine.valid) return;
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
  let networkVersion = networkSnapshot.version;
  const lastNetworkVersion = entity.getDynamicProperty("last_network_version") ?? -1;
  const hasNetworkSnapshot = Boolean(networkSnapshot.networkId);
  const hasRenderedNetworkItems = !hasNetworkSnapshot && (
    Object.keys(getRenderedSlotMap(entity)).length > 0 ||
    hasVisibleVirtualStorageItems(inv)
  );
  if (!hasNetworkSnapshot && (lastNetworkVersion !== 0 || hasRenderedNetworkItems)) {
    forceRefresh = true;
    entity.setDynamicProperty("force_refresh", true);
    entity.setDynamicProperty("last_rendered_page", -1);
  }
  const hasPendingBurnSlot = hasBurnSlotItem(inv);
  const canUseNetworkDeltas =
    hasNetworkSnapshot &&
    !forceRefresh &&
    !controlsChanged &&
    !hasPendingBurnSlot &&
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
        Boolean(fullSnapshot.networkId),
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
  const shouldScanInput =
    forceRefresh || controlsChanged || hasPendingBurnSlot || currentTick % 10 === 0;
  const hasPendingInput =
    hasPendingBurnSlot ||
    (shouldScanInput ? hasActionableStorageItems(inv) : false);
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
    controlsChanged ||
    gridNeedsRepair;
  const controlsNeedUpdate = gridNeedsRender || pageCount !== lastPageCount;
  if (controlsNeedUpdate) {
    const prevItem = new ItemStack("utilitycraft:ui_filler", 1);
    prevItem.nameTag = `§r§7- Previous Page §f${currentPage + 1}/${pageCount}`;
    inv.setItem(PREVIOUS_SLOT, prevItem);
    const nextItem = new ItemStack("utilitycraft:ui_filler", 1);
    nextItem.nameTag = `§r§7- Next Page §f${currentPage + 1}/${pageCount}`;
    inv.setItem(NEXT_SLOT, nextItem);
    const qtyItem = new ItemStack("utilitycraft:ui_filler", 1);
    qtyItem.nameTag = `§r§7- Quantity: §f${currentQty}`;
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
      const newCount = Number(updatedNetwork?.totals?.[itemKey] ?? 0);
      if (newCount <= 0) {
        const updatedTotals = updatedNetwork?.totals ?? {};
        const nextPageCount = getPageCountFromTotals(updatedTotals);
        const nextPage = Math.max(0, Math.min(currentPage, nextPageCount - 1));
        if (nextPage !== currentPage) entity.setDynamicProperty("page", nextPage);
        renderStorageTerminalPage(
          entity,
          inv,
          machine,
          nodes.networkId,
          hasNetwork,
          updatedTotals,
          nextPage,
          nextPageCount,
          currentQty,
          currentSort,
        );
        syncTerminalNetworkState(
          entity,
          updatedNetwork,
          updatedTotals,
          updatedNetwork?.version ?? networkVersion,
        );
        entity.setDynamicProperty("force_refresh", false);
        return;
      }
      updateVisibleVirtualItem(
        entity,
        inv,
        machine,
        nodes.networkId,
        itemKey,
        newCount,
        currentQty,
      );
      entity.setDynamicProperty("last_network_version", updatedNetwork?.version ?? networkVersion);
      entity.setDynamicProperty(
        "last_network_change_seq",
        Math.floor(Number(updatedNetwork?.changeSeq ?? 0)),
      );
      entity.setDynamicProperty(
        "last_network_state",
        JSON.stringify(updatedNetwork?.totals ?? {}),
      );
      return;
    }
  }
  for (let i = STORAGE_START; i <= STORAGE_END; i++) {
    let item = inv.getItem(i);
    if (!item) continue;
    if (item.typeId === "utilitycraft:storage_filler") continue;
    if (getStoredCount(item) === -1 && !isStorageCell(item)) {
      if (!hasNetwork) {
        returnToPlayer(block, item);
        inv.setItem(i, undefined);
        continue;
      }

      const itemKey = getItemKey(item);
      const originalAmount = item.amount;
      const remaining = addItemsToNetwork(nodes, item);
      if (remaining >= originalAmount) continue;

      inv.setItem(
        i,
        remaining > 0 ? createItemFromKey(itemKey, remaining) : undefined,
      );
      const updatedNetwork = readNetworkRecord(nodes.networkId);
      const newCount = Number(updatedNetwork?.totals?.[itemKey] ?? 0);
      const renderedSlots = getRenderedSlotMap(entity);
      if (Number.isInteger(renderedSlots[itemKey])) {
        updateVisibleVirtualItem(
          entity,
          inv,
          machine,
          nodes.networkId,
          itemKey,
          newCount,
          currentQty,
        );
        entity.setDynamicProperty("last_network_version", updatedNetwork?.version ?? networkVersion);
        entity.setDynamicProperty(
          "last_network_change_seq",
          Math.floor(Number(updatedNetwork?.changeSeq ?? 0)),
        );
        entity.setDynamicProperty(
          "last_network_state",
          JSON.stringify(updatedNetwork?.totals ?? {}),
        );
      } else {
        syncTerminalNetworkState(
          entity,
          updatedNetwork,
          updatedNetwork?.totals ?? {},
          updatedNetwork?.version ?? networkVersion,
        );
      }
    }
  }

  if (hasNetwork) {
    let burnItem = inv.getItem(BURN_SLOT);
    if (burnItem && getStoredCount(burnItem) === -1) {
      let originalAmount = burnItem.amount;
      let itemKey = getItemKey(burnItem);
      let remaining = addItemsToNetwork(nodes, burnItem);
      if (remaining < originalAmount) {
        inv.setItem(
          BURN_SLOT,
          remaining === 0
            ? undefined
            : createItemFromKey(itemKey, remaining),
        );
        const updatedNetwork = readNetworkRecord(nodes.networkId);
        const newCount = Number(updatedNetwork?.totals?.[itemKey] ?? 0);
        const renderedSlots = getRenderedSlotMap(entity);
        if (Number.isInteger(renderedSlots[itemKey])) {
          updateVisibleVirtualItem(
            entity,
            inv,
            machine,
            nodes.networkId,
            itemKey,
            newCount,
            currentQty,
          );
          entity.setDynamicProperty("last_network_version", updatedNetwork?.version ?? networkVersion);
          entity.setDynamicProperty(
            "last_network_change_seq",
            Math.floor(Number(updatedNetwork?.changeSeq ?? 0)),
          );
          entity.setDynamicProperty(
            "last_network_state",
            JSON.stringify(updatedNetwork?.totals ?? {}),
          );
          return;
        } else {
          syncTerminalNetworkState(
            entity,
            updatedNetwork,
            updatedNetwork?.totals ?? {},
            updatedNetwork?.version ?? networkVersion,
          );
          return;
        }
      }
    }
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
