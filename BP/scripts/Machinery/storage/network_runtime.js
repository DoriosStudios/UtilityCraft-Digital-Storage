import { system } from "@minecraft/server";
import {
  allocateNetworkId,
  deleteNetworkRecord,
  readCellRecord,
  readNetworkIndex,
  readNetworkRecord,
  releaseCellNetwork,
  setCellNetwork,
  writeCellRecord,
  writeCellRecordJob,
  writeNetworkRecord,
} from "./cell_store.js";
import { syncNetworkDriveCellItems } from "./cell_item_sync.js";
import { createItemFromKey, getItemKey } from "./item_registry.js";
import {
  discardOpaqueItem,
  isOpaqueItem,
  isOpaqueItemKey,
  storeOpaqueItem,
  takeOpaqueItem,
} from "./opaque_vault.js";
import {
  getEntriesStorageSummary,
  getEntryStorageDelta,
  getMaxInsertAmount,
} from "./storage_cost.js";
import { hasPendingCellTransaction } from "./persistence/cell_transactions.js";
import { normalizeWirelessRange } from "./wireless_access.js";

/**
 * Runtime network manager for Digital Storage.
 *
 * While a network is online, all item operations should go through this module.
 * It keeps fast in-memory maps and only persists to world dynamic properties at
 * explicit boundaries such as flush, power off, or world shutdown.
 */

const CHANGE_LIMIT = 64;
const UI_ELEMENT_TAG = "utilitycraft:ui_element";
const AUTO_FLUSH_INTERVAL_TICKS = 100;
const AUTO_FLUSH_COOLDOWN_TICKS = 1200;
const uiElementKeyCache = new Map();
const activeFlushJobs = new Map();
let autoFlushRunId;
let autoFlushCursor = 0;
let storageRuntimeReady = false;
let storageRuntimeFailure;

export function isStorageRuntimeReady() {
  return storageRuntimeReady;
}

export function getStorageRuntimeFailure() {
  return storageRuntimeFailure;
}

export function markStorageRuntimeFailure(error) {
  storageRuntimeReady = false;
  storageRuntimeFailure = String(error?.message ?? error ?? "unknown_storage_error").slice(0, 96);
}

function isUiElementKey(itemKey) {
  const key = String(itemKey ?? "");
  if (!key) return false;
  if (isOpaqueItemKey(key)) return false;
  if (uiElementKeyCache.has(key)) return uiElementKeyCache.get(key);

  let isUiElement = false;
  try {
    const item = createItemFromKey(key, 1);
    isUiElement = item.hasTag?.(UI_ELEMENT_TAG) === true
      || item.getTags?.().includes(UI_ELEMENT_TAG) === true;
  } catch {
    isUiElement = false;
  }

  uiElementKeyCache.set(key, isUiElement);
  return isUiElement;
}

/**
 * Active runtime networks keyed by network id.
 *
 * A powered-off network is deliberately removed from this map. Offline networks
 * may have cell changes, so the next activation must rebuild from persistent
 * records/topology.
 *
 * @type {Map<number, object>}
 */
export const runtimeNetworks = new Map();

function toObject(map) {
  const object = {};
  for (const [key, value] of map.entries()) {
    if (value > 0) object[key] = value;
  }
  return object;
}

function toMap(items) {
  const map = new Map();
  for (const key of Object.keys(items ?? {})) {
    const amount = Math.floor(Number(items[key]) || 0);
    if (amount > 0) map.set(key, (map.get(key) ?? 0) + amount);
  }
  return map;
}

function sumMap(map) {
  let total = 0;
  for (const value of map.values()) total += Math.max(0, Math.floor(Number(value) || 0));
  return total;
}

function createRuntimeCell(cell, networkId) {
  const items = toMap(cell.items);
  const summary = getEntriesStorageSummary(items);
  const capacityUnits = Math.max(0, Math.floor(Number(cell.capacityUnits ?? cell.capacity) || 0));
  return {
    cellId: cell.cellId,
    networkId,
    version: cell.version,
    revision: cell.version,
    persistedRevision: cell.version,
    capacityUnits,
    usedUnits: summary.usedUnits,
    itemCount: summary.itemCount,
    typeCount: summary.typeCount,
    capacity: capacityUnits,
    used: summary.usedUnits,
    items,
    dirty: false,
  };
}

function attachRuntimeCell(runtime, cell) {
  const runtimeCell = createRuntimeCell(cell, runtime.networkId);
  runtime.cells.set(runtimeCell.cellId, runtimeCell);
  runtime.capacityUnits += runtimeCell.capacityUnits;
  runtime.usedUnits += runtimeCell.usedUnits;
  runtime.itemCount += runtimeCell.itemCount;
  for (const [itemKey, amount] of runtimeCell.items) {
    runtime.totals.set(itemKey, (runtime.totals.get(itemKey) ?? 0) + amount);
    let locations = runtime.locationsByKey.get(itemKey);
    if (!locations) {
      locations = new Set();
      runtime.locationsByKey.set(itemKey, locations);
    }
    locations.add(runtimeCell.cellId);
  }
}

function syncRuntimeAliases(runtime) {
  runtime.capacity = runtime.capacityUnits;
  runtime.used = runtime.usedUnits;
  runtime.typeCount = runtime.totals.size;
}

function markCellMutation(runtime, cell) {
  cell.revision += 1;
  cell.dirty = true;
  cell.used = cell.usedUnits;
  runtime.dirty = true;
}

function pushChange(runtime, itemKey, before, after, reason = "runtime") {
  runtime.changeSeq += 1;
  runtime.version += 1;
  runtime.changes.push({
    seq: runtime.changeSeq,
    itemKey,
    before,
    after,
    reason,
  });
  if (runtime.changes.length > CHANGE_LIMIT) {
    runtime.changes.splice(0, runtime.changes.length - CHANGE_LIMIT);
  }
  queueTerminalItemUpdate(runtime, itemKey, after);
}

function createTerminalDisplayState() {
  return {
    renderedSlots: new Map(),
    knownItemKeys: new Set(),
    pendingUpdates: new Map(),
    page: 0,
    visibleCount: 0,
    gridStart: 0,
    gridSize: 0,
    nextFreeSlot: -1,
    forceReload: false,
    lastSeenTick: 0,
  };
}

function getTerminalDisplays(runtime) {
  if (!runtime.terminalDisplays) runtime.terminalDisplays = new Map();
  return runtime.terminalDisplays;
}

function queueTerminalItemUpdate(runtime, itemKey, amount) {
  const normalizedAmount = Math.max(0, Math.floor(Number(amount) || 0));
  const terminalDisplays = getTerminalDisplays(runtime);
  for (const state of terminalDisplays.values()) {
    if (state.renderedSlots.has(itemKey)) {
      state.pendingUpdates.set(itemKey, normalizedAmount);
      if (normalizedAmount <= 0) state.forceReload = true;
      continue;
    }

    if (normalizedAmount <= 0) {
      state.knownItemKeys.delete(itemKey);
      continue;
    }

    if (state.knownItemKeys.has(itemKey)) continue;

    const currentLastPage = state.gridSize > 0
      ? Math.floor(state.knownItemKeys.size / state.gridSize)
      : -1;
    if (state.page !== currentLastPage) {
      state.knownItemKeys.add(itemKey);
      continue;
    }

    const slot = reserveTerminalDisplaySlot(state);
    if (slot < 0) {
      state.knownItemKeys.add(itemKey);
      continue;
    }

    state.renderedSlots.set(itemKey, slot);
    state.knownItemKeys.add(itemKey);
    state.visibleCount = state.renderedSlots.size;
    state.pendingUpdates.set(itemKey, normalizedAmount);
  }
}

function reserveTerminalDisplaySlot(state) {
  const gridStart = Math.max(0, Math.floor(Number(state.gridStart) || 0));
  const gridSize = Math.max(0, Math.floor(Number(state.gridSize) || 0));
  if (gridSize <= 0) return -1;
  if (Math.floor(Number(state.nextFreeSlot) || -1) < 0) return -1;

  const gridEnd = gridStart + gridSize - 1;
  let slot = Math.floor(Number(state.nextFreeSlot) || gridStart);
  if (slot < gridStart) slot = gridStart;

  while (slot <= gridEnd && isSlotRendered(state, slot)) slot += 1;
  state.nextFreeSlot = slot <= gridEnd ? slot + 1 : -1;
  return slot <= gridEnd ? slot : -1;
}

function isSlotRendered(state, slot) {
  for (const renderedSlot of state.renderedSlots.values()) {
    if (renderedSlot === slot) return true;
  }
  return false;
}

function updateTerminalDisplayBounds(state, { gridStart = 0, gridSize = 0 } = {}) {
  state.gridStart = Math.max(0, Math.floor(Number(gridStart) || 0));
  state.gridSize = Math.max(0, Math.floor(Number(gridSize) || 0));
  state.nextFreeSlot = getNextFreeSlotAfterRenderedItems(state);
}

function getNextFreeSlotAfterRenderedItems(state) {
  if (state.gridSize <= 0) return -1;

  const gridEnd = state.gridStart + state.gridSize - 1;
  let lastUsedSlot = state.gridStart - 1;
  for (const slot of state.renderedSlots.values()) {
    if (slot >= state.gridStart && slot <= gridEnd && slot > lastUsedSlot) {
      lastUsedSlot = slot;
    }
  }

  const nextSlot = lastUsedSlot + 1;
  return nextSlot <= gridEnd ? nextSlot : -1;
}

/**
 * Builds a runtime network object from one network record and its cell records.
 *
 * @param {object} networkRecord Persistent network record.
 * @param {object[]} cellRecords Persistent cell records that belong to it.
 * @returns {object} Runtime network.
 */
function buildRuntime(networkRecord, cellRecords) {
  const runtime = {
    networkId: networkRecord.networkId,
    online: networkRecord.online === true,
    state: networkRecord.state ?? (networkRecord.online === true ? "online" : "offline"),
    dirty: false,
    cells: new Map(),
    totals: new Map(),
    locationsByKey: new Map(),
    usedUnits: 0,
    capacityUnits: 0,
    itemCount: 0,
    typeCount: 0,
    version: Math.floor(Number(networkRecord.version ?? 0)),
    changeSeq: Math.floor(Number(networkRecord.changeSeq ?? 0)),
    changes: Array.isArray(networkRecord.changes) ? [...networkRecord.changes] : [],
    center: networkRecord.center,
    wirelessRange: normalizeWirelessRange(networkRecord.wirelessRange),
    wirelessDimensional: networkRecord.wirelessDimensional === true,
    centers: new Set(networkRecord.centers ?? []),
    drives: new Set(networkRecord.drives ?? []),
    terminals: new Set(networkRecord.terminals ?? []),
    terminalDisplays: new Map(),
    lastAutoFlushTick: system.currentTick,
  };
  for (const cell of cellRecords) {
    if (cell) attachRuntimeCell(runtime, cell);
  }
  syncRuntimeAliases(runtime);
  return runtime;
}

/**
 * Loads one network from persistent records into runtime cache.
 *
 * Cells whose `networkId` belongs to another network are ignored to avoid
 * accidental cross-network item mixing.
 *
 * @param {number} networkId Network id.
 * @returns {object | undefined} Runtime network.
 */
export function loadNetwork(networkId) {
  const record = readNetworkRecord(networkId);
  if (!record) return undefined;

  const cells = [];
  for (const cellId of record.cells) {
    const cell = readCellRecord(cellId);
    if (!cell) continue;
    if (cell.networkId && cell.networkId !== record.networkId) continue;
    cells.push(cell);
  }

  const runtime = buildRuntime(record, cells);
  runtimeNetworks.set(record.networkId, runtime);
  return runtime;
}

/**
 * Loads all known networks from the network index.
 *
 * Used on world load. This creates runtime objects, but the records themselves
 * decide whether they are online.
 *
 * @returns {number} Number of networks loaded.
 */
export function loadAllNetworks() {
  runtimeNetworks.clear();
  storageRuntimeFailure = undefined;
  for (const networkId of readNetworkIndex()) {
    loadNetwork(networkId);
  }
  storageRuntimeReady = true;
  return runtimeNetworks.size;
}

/**
 * Incrementally loads all known networks.
 *
 * This is intended for world startup. Reading many network/cell dynamic
 * properties in a single tick can spike, so this generator yields after a small
 * amount of work and lets `system.runJob` continue on later ticks.
 *
 * @param {{recordsPerTick?: number, onComplete?: (result: {loaded:number, total:number, cells:number}) => void}} [options]
 * @returns {Generator<void, void, void>} Startup load job.
 */
export function* loadAllNetworksJob({ recordsPerTick = 8, onComplete } = {}) {
  runtimeNetworks.clear();
  storageRuntimeReady = false;
  storageRuntimeFailure = undefined;

  const networkIds = readNetworkIndex();
  const workLimit = Math.max(1, Math.floor(Number(recordsPerTick) || 1));
  let workDone = 0;
  let loaded = 0;
  let cellsRead = 0;

  for (const networkId of networkIds) {
    const record = readNetworkRecord(networkId);
    workDone += 1;
    if (workDone >= workLimit) {
      workDone = 0;
      yield;
    }
    if (!record) continue;

    const runtime = {
      networkId: record.networkId,
      online: record.online === true,
      state: record.state ?? (record.online === true ? "online" : "offline"),
      dirty: false,
      cells: new Map(),
      totals: new Map(),
      locationsByKey: new Map(),
      usedUnits: 0,
      capacityUnits: 0,
      itemCount: 0,
      typeCount: 0,
      version: Math.floor(Number(record.version ?? 0)),
      changeSeq: Math.floor(Number(record.changeSeq ?? 0)),
      changes: Array.isArray(record.changes) ? [...record.changes] : [],
      center: record.center,
      wirelessRange: normalizeWirelessRange(record.wirelessRange),
      wirelessDimensional: record.wirelessDimensional === true,
      centers: new Set(record.centers ?? []),
      drives: new Set(record.drives ?? []),
      terminals: new Set(record.terminals ?? []),
      terminalDisplays: new Map(),
      lastAutoFlushTick: system.currentTick,
    };

    for (const cellId of record.cells) {
      let cell = readCellRecord(cellId);
      cellsRead += 1;
      workDone += 1;

      if (cell?.schemaVersion === 1) {
        try {
          const migrated = yield* writeCellRecordJob(cell.cellId, {
            ...cell,
            version: cell.version,
            capacityUnits: cell.capacityUnits,
            items: cell.items,
          });
          if (migrated) cell = migrated;
        } catch (error) {
          console.warn(`[DigitalStorage] Unable to migrate cell ${cell.cellId}: ${error?.message ?? error}`);
        }
      }

      if (cell && (!cell.networkId || cell.networkId === record.networkId)) {
        attachRuntimeCell(runtime, cell);
      }

      if (workDone >= workLimit) {
        workDone = 0;
        yield;
      }
    }

    syncRuntimeAliases(runtime);
    runtimeNetworks.set(record.networkId, runtime);
    loaded += 1;
  }

  storageRuntimeReady = true;
  onComplete?.({ loaded, total: networkIds.length, cells: cellsRead });
}

/**
 * Gets a runtime network, loading it from persistent records when needed.
 *
 * @param {number} networkId Network id.
 * @returns {object | undefined} Runtime network.
 */
export function getNetwork(networkId) {
  const id = Math.floor(Number(networkId) || 0);
  if (runtimeNetworks.has(id)) return runtimeNetworks.get(id);
  return loadNetwork(id);
}

/**
 * Finds the active network currently owned by one Storage Center position.
 *
 * Center positions remain stable when a network is rebuilt and receives a new
 * runtime id, making them suitable for wireless panel links.
 *
 * @param {string} centerKey Serialized center dimension and block position.
 * @returns {object | undefined} Online runtime owned by that center.
 */
export function getOnlineNetworkByCenter(centerKey) {
  const key = String(centerKey ?? "");
  if (!key) return undefined;

  for (const runtime of runtimeNetworks.values()) {
    if (runtime?.online && runtime.center === key) return runtime;
  }
  return undefined;
}

/**
 * Registers one open/active terminal display against a runtime network.
 *
 * This state is intentionally runtime-only. A terminal that is not ticking does
 * not consume work, and powering off a network drops every display registration.
 *
 * @param {number} networkId Network id.
 * @param {string} terminalId Entity id for the terminal.
 * @returns {object | undefined} Runtime display state.
 */
export function registerTerminalDisplay(networkId, terminalId) {
  const runtime = getNetwork(networkId);
  if (!runtime || !terminalId) return undefined;

  const terminalDisplays = getTerminalDisplays(runtime);
  let state = terminalDisplays.get(terminalId);
  if (!state) {
    state = createTerminalDisplayState();
    terminalDisplays.set(terminalId, state);
  }
  state.lastSeenTick = runtime.changeSeq;
  return state;
}

/**
 * Removes one terminal display from a runtime network.
 *
 * @param {number} networkId Network id.
 * @param {string} terminalId Entity id for the terminal.
 * @returns {boolean} True when a display state was removed.
 */
export function unregisterTerminalDisplay(networkId, terminalId) {
  const runtime = getNetwork(networkId);
  if (!runtime || !terminalId) return false;
  return getTerminalDisplays(runtime).delete(terminalId);
}

/**
 * Replaces a terminal's visible item-key-to-slot map after a full page render.
 *
 * Pending item updates are cleared because the render was made from current
 * runtime totals.
 *
 * @param {number} networkId Network id.
 * @param {string} terminalId Entity id for the terminal.
 * @param {Map<string, number> | Record<string, number>} renderedSlots Visible item slots.
 * @param {{page?: number, visibleCount?: number, gridStart?: number, gridSize?: number, knownItemKeys?: Iterable<string>}} [options]
 * @returns {boolean} True when stored.
 */
export function setTerminalRenderedSlots(networkId, terminalId, renderedSlots, options = {}) {
  const state = registerTerminalDisplay(networkId, terminalId);
  if (!state) return false;

  const slots = new Map();
  const entries = renderedSlots instanceof Map
    ? renderedSlots.entries()
    : Object.entries(renderedSlots ?? {});
  for (const [itemKey, slot] of entries) {
    const normalizedSlot = Math.floor(Number(slot) || 0);
    if (itemKey && normalizedSlot >= 0) slots.set(itemKey, normalizedSlot);
  }

  state.renderedSlots = slots;
  state.knownItemKeys = new Set(options.knownItemKeys ?? slots.keys());
  state.pendingUpdates.clear();
  state.forceReload = false;
  state.page = Math.max(0, Math.floor(Number(options.page) || 0));
  state.visibleCount = Math.max(0, Math.floor(Number(options.visibleCount ?? slots.size) || 0));
  updateTerminalDisplayBounds(state, options);
  return true;
}

/**
 * Consumes and clears pending visible item updates for one terminal.
 *
 * If an item reached zero, its rendered slot is removed from the display map.
 * It will not reappear automatically until the terminal reloads its page.
 *
 * @param {number} networkId Network id.
 * @param {string} terminalId Entity id for the terminal.
 * @returns {{updates:Array<{itemKey:string, amount:number, slot:number}>, forceReload:boolean}} Direct UI updates and reload flag.
 */
export function consumeTerminalItemUpdates(networkId, terminalId) {
  const runtime = getNetwork(networkId);
  if (!runtime || !terminalId) return { updates: [], forceReload: false };

  const state = getTerminalDisplays(runtime).get(terminalId);
  if (!state) return { updates: [], forceReload: false };

  const updates = [];
  for (const [itemKey, amount] of state.pendingUpdates.entries()) {
    const slot = state.renderedSlots.get(itemKey);
    if (slot !== undefined) {
      updates.push({ itemKey, amount, slot });
      if (amount <= 0) state.renderedSlots.delete(itemKey);
    }
  }
  const forceReload = state.forceReload === true;
  state.pendingUpdates.clear();
  state.forceReload = false;
  state.visibleCount = state.renderedSlots.size;
  state.nextFreeSlot = getNextFreeSlotAfterRenderedItems(state);
  state.lastSeenTick = runtime.changeSeq;
  return { updates, forceReload };
}

/**
 * Creates a serializable snapshot for UI/debug consumers.
 *
 * @param {number} networkId Network id.
 * @returns {object | undefined} Snapshot with totals, usage and change cursor.
 */
export function getNetworkSnapshot(networkId) {
  const runtime = getNetwork(networkId);
  if (!runtime) return undefined;

  return {
    networkId: runtime.networkId,
    online: runtime.online,
    state: runtime.state,
    dirty: runtime.dirty,
    wirelessRange: runtime.wirelessRange,
    wirelessDimensional: runtime.wirelessDimensional,
    itemCount: runtime.itemCount,
    typeCount: runtime.typeCount,
    usedUnits: runtime.usedUnits,
    capacityUnits: runtime.capacityUnits,
    freeUnits: Math.max(0, runtime.capacityUnits - runtime.usedUnits),
    overCapacityUnits: Math.max(0, runtime.usedUnits - runtime.capacityUnits),
    used: runtime.usedUnits,
    capacity: runtime.capacityUnits,
    free: Math.max(0, runtime.capacityUnits - runtime.usedUnits),
    version: runtime.version,
    changeSeq: runtime.changeSeq,
    cells: [...runtime.cells.keys()],
    totals: toObject(runtime.totals),
    changes: [...runtime.changes],
  };
}

/**
 * Creates or replaces a network using the provided cells.
 *
 * This is currently used by debug tooling and later can be used by the network
 * center when it scans connected drives. Each cell is marked as owned by this
 * network before the runtime is built.
 *
 * @param {number[]} cellIds Cell ids to attach.
 * @param {{networkId?: number, online?: boolean, center?: string, wirelessRange?: number, wirelessDimensional?: boolean, centers?: string[], drives?: string[], terminals?: string[], allowReassign?: boolean}} [options]
 * @returns {object} Runtime network.
 */
export function createNetworkFromCellIds(cellIds, options = {}) {
  if (!storageRuntimeReady) throw new Error("storage_runtime_loading");
  const requestedNetworkId = Math.floor(Number(options.networkId) || 0);
  const allocatedNetworkId = requestedNetworkId <= 0;
  const networkId = requestedNetworkId || allocateNetworkId();
  const uniqueCells = [...new Set(cellIds.map((id) => Math.floor(Number(id) || 0)).filter(Boolean))];
  const candidates = [];

  for (const cellId of uniqueCells) {
    if (hasPendingCellTransaction(cellId)) {
      throw new Error(`Cell ${cellId} has a pending storage transaction.`);
    }
    const cell = readCellRecord(cellId);
    if (!cell) continue;
    if (
      options.allowReassign !== true &&
      cell.networkId &&
      cell.networkId !== networkId
    ) {
      throw new Error(`Cell ${cellId} already belongs to network ${cell.networkId}.`);
    }
    candidates.push(cell);
  }

  const claimed = [];
  try {
    const cells = [];
    for (const cell of candidates) {
      const owned = setCellNetwork(cell.cellId, networkId);
      if (!owned) throw new Error(`Unable to claim cell ${cell.cellId}.`);
      cells.push(owned);
      claimed.push({ cellId: cell.cellId, previousNetworkId: cell.networkId });
    }

    const capacityUnits = cells.reduce((sum, cell) => sum + cell.capacityUnits, 0);
    const usedUnits = cells.reduce((sum, cell) => sum + cell.usedUnits, 0);
    const itemCount = cells.reduce((sum, cell) => sum + cell.itemCount, 0);
    if (![capacityUnits, usedUnits, itemCount].every(Number.isSafeInteger)) {
      throw new Error("network_totals_exceed_safe_integer");
    }
    const typeCount = new Set(cells.flatMap((cell) => Object.keys(cell.items ?? {}))).size;
    const record = writeNetworkRecord(networkId, {
      networkId,
      version: readNetworkRecord(networkId)?.version ?? 0,
      online: options.online !== false,
      center: options.center,
      wirelessRange: normalizeWirelessRange(options.wirelessRange),
      wirelessDimensional: options.wirelessDimensional === true,
      centers: options.centers ?? [],
      drives: options.drives ?? [],
      terminals: options.terminals ?? [],
      cells: cells.map((cell) => cell.cellId),
      capacityUnits,
      usedUnits,
      itemCount,
      typeCount,
      changeSeq: 0,
      changes: [],
    });
    if (!record) throw new Error("network_record_write_failed");
    const runtime = loadNetwork(record.networkId);
    if (!runtime) throw new Error("network_record_load_failed");
    return runtime;
  } catch (error) {
    for (const claim of claimed.reverse()) {
      try {
        setCellNetwork(claim.cellId, claim.previousNetworkId);
      } catch (rollbackError) {
        console.warn(`[DigitalStorage] Unable to roll back cell ${claim.cellId}: ${rollbackError?.message ?? rollbackError}`);
      }
    }
    if (allocatedNetworkId) deleteNetworkRecord(networkId);
    throw error;
  }
}

/**
 * Updates and immediately persists the wireless access cached by one network.
 * This write only touches the network record; dirty cell contents keep their
 * normal incremental flush cadence.
 *
 * @param {number} networkId Network id.
 * @param {{range?:number, dimensional?:boolean}} access Wireless access settings.
 * @returns {boolean} True when the settings changed.
 */
export function setNetworkWirelessAccess(networkId, access = {}) {
  const runtime = getNetwork(networkId);
  if (!runtime) return false;

  const nextRange = normalizeWirelessRange(access.range);
  const nextDimensional = access.dimensional === true;
  if (
    runtime.wirelessRange === nextRange
    && runtime.wirelessDimensional === nextDimensional
  ) {
    return false;
  }

  const previousRange = runtime.wirelessRange;
  const previousDimensional = runtime.wirelessDimensional;
  runtime.wirelessRange = nextRange;
  runtime.wirelessDimensional = nextDimensional;

  try {
    const saved = writeNetworkRecord(runtime.networkId, {
      networkId: runtime.networkId,
      version: runtime.version,
      state: runtime.state,
      online: runtime.online,
      center: runtime.center,
      wirelessRange: runtime.wirelessRange,
      wirelessDimensional: runtime.wirelessDimensional,
      centers: [...runtime.centers],
      drives: [...runtime.drives],
      terminals: [...runtime.terminals],
      cells: [...runtime.cells.keys()],
      usedUnits: runtime.usedUnits,
      capacityUnits: runtime.capacityUnits,
      itemCount: runtime.itemCount,
      typeCount: runtime.typeCount,
      changeSeq: runtime.changeSeq,
      changes: runtime.changes,
    });
    if (!saved) throw new Error("network_wireless_settings_write_failed");
    runtime.version = saved.version;
    return true;
  } catch (error) {
    runtime.wirelessRange = previousRange;
    runtime.wirelessDimensional = previousDimensional;
    throw error;
  }
}

/**
 * Sets a network online or powers it off.
 *
 * Passing `false` performs a real power off: flush, mark offline and remove the
 * runtime from cache.
 *
 * @param {number} networkId Network id.
 * @param {boolean} online Desired state.
 * @returns {boolean} True when the network existed.
 */
export function setNetworkOnline(networkId, online) {
  if (online !== true) return powerOffNetwork(networkId);

  const runtime = getNetwork(networkId);
  if (!runtime) return false;
  runtime.online = true;
  runtime.state = "online";
  runtime.dirty = true;
  return true;
}

/**
 * Adds items to an online network runtime.
 *
 * No world dynamic properties are written here. The operation only mutates the
 * runtime totals and marks the network dirty.
 *
 * @param {number} networkId Network id.
 * @param {string} itemKey Stable item key.
 * @param {number} amount Requested insert amount.
 * @param {string} [reason] Change reason for debug/change stream.
 * @returns {object}
 */
export function addItem(networkId, itemKey, amount, reason = "debug") {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  if (!storageRuntimeReady) return { inserted: 0, remaining: requested, reason: "storage_loading" };
  if (!itemKey) return { inserted: 0, remaining: requested };
  if (isUiElementKey(itemKey)) return { inserted: 0, remaining: requested };

  const runtime = getNetwork(networkId);
  if (!runtime || !runtime.online || runtime.state === "closing" || runtime.state === "faulted") {
    return { inserted: 0, remaining: requested };
  }
  const before = Math.floor(Number(runtime.totals.get(itemKey) ?? 0));
  let remaining = requested;
  let unitDelta = 0;
  const existing = [];
  const empty = [];
  for (const cell of runtime.cells.values()) {
    if (cell.items.has(itemKey)) existing.push(cell);
    else empty.push(cell);
  }
  existing.sort((a, b) => b.capacityUnits - b.usedUnits - (a.capacityUnits - a.usedUnits) || a.cellId - b.cellId);
  empty.sort((a, b) => (a.capacityUnits - a.usedUnits) - (b.capacityUnits - b.usedUnits) || a.cellId - b.cellId);

  for (const cell of [...existing, ...empty]) {
    if (remaining <= 0) break;
    const cellBefore = Math.floor(Number(cell.items.get(itemKey) ?? 0));
    const freeUnits = Math.max(0, cell.capacityUnits - cell.usedUnits);
    const accepted = getMaxInsertAmount(itemKey, cellBefore, freeUnits, remaining);
    if (accepted <= 0) continue;
    const cellAfter = cellBefore + accepted;
    const delta = getEntryStorageDelta(itemKey, cellBefore, cellAfter);
    if (!Number.isSafeInteger(cellAfter) || !Number.isSafeInteger(delta) || delta > freeUnits) continue;

    cell.items.set(itemKey, cellAfter);
    cell.itemCount += accepted;
    if (cellBefore <= 0) cell.typeCount += 1;
    cell.usedUnits += delta;
    markCellMutation(runtime, cell);
    let locations = runtime.locationsByKey.get(itemKey);
    if (!locations) {
      locations = new Set();
      runtime.locationsByKey.set(itemKey, locations);
    }
    locations.add(cell.cellId);
    remaining -= accepted;
    unitDelta += delta;
  }

  const inserted = requested - remaining;
  if (inserted <= 0) return { inserted: 0, remaining: requested, reason: "no_capacity" };
  const after = before + inserted;
  runtime.totals.set(itemKey, after);
  runtime.itemCount += inserted;
  runtime.usedUnits += unitDelta;
  syncRuntimeAliases(runtime);
  pushChange(runtime, itemKey, before, after, reason);

  return { inserted, remaining, before, after, unitDelta };
}

/**
 * Adds a real ItemStack through the correct storage path.
 *
 * Stackable items keep using logical keys and amounts. Items whose maximum
 * stack size is one are first copied into a native vault slot, then their
 * unique reference is committed to the network.
 *
 * @param {number} networkId Network id.
 * @param {import("@minecraft/server").ItemStack} item ItemStack to insert.
 * @param {string} [reason] Change reason.
 * @returns {{inserted:number, remaining:number, before?:number, after?:number, itemKey?:string, reason?:string}}
 */
export function addItemStack(networkId, item, reason = "debug") {
  const requested = Math.max(0, Math.floor(Number(item?.amount) || 0));
  if (!item || requested <= 0) return { inserted: 0, remaining: requested };
  if (!storageRuntimeReady) return { inserted: 0, remaining: requested, reason: "storage_loading" };

  try {
    if (item.hasTag?.(UI_ELEMENT_TAG) || item.getTags?.().includes(UI_ELEMENT_TAG)) {
      return { inserted: 0, remaining: requested };
    }
  } catch {}

  if (!isOpaqueItem(item)) {
    const itemKey = getItemKey(item);
    return { ...addItem(networkId, itemKey, requested, reason), itemKey };
  }

  const runtime = getNetwork(networkId);
  if (!runtime?.online || runtime.state === "closing" || runtime.state === "faulted") {
    return { inserted: 0, remaining: requested };
  }

  const stored = storeOpaqueItem(item);
  if (!stored.stored || !stored.itemKey) {
    return { inserted: 0, remaining: requested, reason: stored.reason };
  }

  const result = addItem(networkId, stored.itemKey, 1, reason);
  if (result.inserted <= 0) discardOpaqueItem(stored.itemKey);
  return {
    ...result,
    remaining: Math.max(0, requested - result.inserted),
    itemKey: stored.itemKey,
  };
}

/**
 * Removes items from an online network runtime.
 *
 * No world dynamic properties are written here. The caller is responsible for
 * creating the output ItemStack from the returned amount.
 *
 * @param {number} networkId Network id.
 * @param {string} itemKey Stable item key.
 * @param {number} amount Requested remove amount.
 * @param {string} [reason] Change reason for debug/change stream.
 * @returns {object}
 */
export function removeItem(networkId, itemKey, amount, reason = "debug") {
  if (!storageRuntimeReady) {
    return { removed: 0, remaining: Math.max(0, Math.floor(Number(amount) || 0)), reason: "storage_loading" };
  }
  const runtime = getNetwork(networkId);
  if (!runtime || !runtime.online || runtime.state === "closing" || runtime.state === "faulted") {
    return { removed: 0, remaining: Math.max(0, Math.floor(Number(amount) || 0)) };
  }

  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  const before = Math.floor(Number(runtime.totals.get(itemKey) ?? 0));
  let itemStack;
  const wanted = Math.min(requested, before);
  if (wanted <= 0) return { removed: 0, remaining: requested, before, after: before };

  const cells = [...(runtime.locationsByKey.get(itemKey) ?? [])]
    .map((cellId) => runtime.cells.get(cellId))
    .filter(Boolean)
    .sort((a, b) => (a.items.get(itemKey) ?? 0) - (b.items.get(itemKey) ?? 0) || a.cellId - b.cellId);
  if (cells.length === 0) return { removed: 0, remaining: requested, before, after: before, reason: "location_missing" };

  if (isOpaqueItemKey(itemKey)) {
    const physical = takeOpaqueItem(itemKey);
    if (!physical.taken || !physical.item) {
      return {
        removed: 0,
        remaining: requested,
        before,
        after: before,
        reason: physical.reason,
      };
    }
    itemStack = physical.item;
  }

  let remainingToRemove = isOpaqueItemKey(itemKey) ? 1 : wanted;
  let unitDelta = 0;

  for (const cell of cells) {
    if (remainingToRemove <= 0) break;
    const cellBefore = Math.floor(Number(cell.items.get(itemKey) ?? 0));
    const take = Math.min(cellBefore, remainingToRemove);
    if (take <= 0) continue;
    const cellAfter = cellBefore - take;
    const delta = getEntryStorageDelta(itemKey, cellBefore, cellAfter);
    if (cellAfter > 0) cell.items.set(itemKey, cellAfter);
    else {
      cell.items.delete(itemKey);
      cell.typeCount = Math.max(0, cell.typeCount - 1);
      runtime.locationsByKey.get(itemKey)?.delete(cell.cellId);
    }
    cell.itemCount -= take;
    cell.usedUnits += delta;
    markCellMutation(runtime, cell);
    remainingToRemove -= take;
    unitDelta += delta;
  }

  const removed = (isOpaqueItemKey(itemKey) ? 1 : wanted) - remainingToRemove;
  if (removed <= 0) return { removed: 0, remaining: requested, before, after: before };
  const after = before - removed;
  if (after > 0) runtime.totals.set(itemKey, after);
  else {
    runtime.totals.delete(itemKey);
    runtime.locationsByKey.delete(itemKey);
  }
  runtime.itemCount -= removed;
  runtime.usedUnits += unitDelta;
  syncRuntimeAliases(runtime);
  pushChange(runtime, itemKey, before, after, reason);

  return { removed, remaining: requested - removed, before, after, itemStack, unitDelta };
}

/**
 * Returns stored items sorted for rendering or debug output.
 *
 * @param {number} networkId Network id.
 * @param {"count" | "name"} [sortMode="count"] Sort mode.
 * @returns {Array<[string, number]>} Item key/amount pairs.
 */
export function getSortedItems(networkId, sortMode = "count") {
  const runtime = getNetwork(networkId);
  if (!runtime) return [];

  const entries = [...runtime.totals.entries()].filter(([, amount]) => amount > 0);
  if (sortMode === "name") {
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Persists one runtime network to cell and network dynamic properties.
 *
 * Each dirty cell is serialized with its existing physical allocation.
 *
 * @param {number} networkId Network id.
 * @param {{syncDriveItems?: boolean}} [options] Flush options.
 * @returns {boolean} True when flushed.
 */
export function flushNetwork(networkId, { syncDriveItems = true } = {}) {
  const runtime = getNetwork(networkId);
  if (!runtime) return false;
  const activeJob = activeFlushJobs.get(runtime.networkId);
  if (activeJob !== undefined) {
    system.clearJob(activeJob);
    activeFlushJobs.delete(runtime.networkId);
  }

  const cellList = [...runtime.cells.values()].sort((a, b) => a.cellId - b.cellId);
  const savedCellsById = new Map();
  for (const cell of cellList) {
    if (!cell.dirty) continue;
    const saved = writeCellRecord(cell.cellId, {
      networkId: runtime.networkId,
      version: cell.version,
      capacityUnits: cell.capacityUnits,
      items: toObject(cell.items),
    });
    if (saved) {
      cell.version = saved.version;
      cell.persistedRevision = cell.revision;
      cell.dirty = false;
      savedCellsById.set(saved.cellId, saved);
    }
  }

  const savedNetwork = writeNetworkRecord(runtime.networkId, {
    networkId: runtime.networkId,
    version: runtime.version,
    state: runtime.state,
    online: runtime.online,
    center: runtime.center,
    wirelessRange: runtime.wirelessRange,
    wirelessDimensional: runtime.wirelessDimensional,
    centers: [...runtime.centers],
    drives: [...runtime.drives],
    terminals: [...runtime.terminals],
    cells: cellList.map((cell) => cell.cellId),
    usedUnits: runtime.usedUnits,
    capacityUnits: runtime.capacityUnits,
    itemCount: runtime.itemCount,
    typeCount: runtime.typeCount,
    changeSeq: runtime.changeSeq,
    changes: runtime.changes,
  });
  if (savedNetwork) runtime.version = savedNetwork.version;

  if (syncDriveItems) {
    try {
      syncNetworkDriveCellItems(runtime, savedCellsById);
    } catch (error) {
      // console.warn(`[DigitalStorage] skipped drive cell item sync for network ${runtime.networkId}: ${error?.message ?? error}`);
    }
  }

  runtime.dirty = [...runtime.cells.values()].some((cell) => cell.dirty);
  return true;
}

export function* flushNetworkJob(networkId, { syncDriveItems = true, pagesPerTick = 2 } = {}) {
  const runtime = getNetwork(networkId);
  if (!runtime) return;
  try {
    const snapshots = [...runtime.cells.values()]
      .filter((cell) => cell.dirty)
      .sort((a, b) => a.cellId - b.cellId)
      .map((cell) => ({
        cellId: cell.cellId,
        version: cell.version,
        revision: cell.revision,
        capacityUnits: cell.capacityUnits,
        items: toObject(cell.items),
      }));
    const savedCellsById = new Map();
    for (const snapshot of snapshots) {
      const saved = yield* writeCellRecordJob(snapshot.cellId, {
        networkId: runtime.networkId,
        version: snapshot.version,
        capacityUnits: snapshot.capacityUnits,
        items: snapshot.items,
      }, { pagesPerTick });
      if (!saved) continue;
      savedCellsById.set(saved.cellId, saved);
      const liveCell = runtime.cells.get(saved.cellId);
      if (!liveCell) continue;
      liveCell.version = saved.version;
      liveCell.persistedRevision = snapshot.revision;
      if (liveCell.revision === snapshot.revision) liveCell.dirty = false;
    }

    const savedNetwork = writeNetworkRecord(runtime.networkId, {
      networkId: runtime.networkId,
      version: runtime.version,
      state: runtime.state,
      online: runtime.online,
      center: runtime.center,
      wirelessRange: runtime.wirelessRange,
      wirelessDimensional: runtime.wirelessDimensional,
      centers: [...runtime.centers],
      drives: [...runtime.drives],
      terminals: [...runtime.terminals],
      cells: [...runtime.cells.keys()],
      usedUnits: runtime.usedUnits,
      capacityUnits: runtime.capacityUnits,
      itemCount: runtime.itemCount,
      typeCount: runtime.typeCount,
      changeSeq: runtime.changeSeq,
    });
    if (savedNetwork) runtime.version = savedNetwork.version;
    if (syncDriveItems && savedCellsById.size > 0) syncNetworkDriveCellItems(runtime, savedCellsById);
    runtime.dirty = [...runtime.cells.values()].some((cell) => cell.dirty);
    return;
  } finally {
    activeFlushJobs.delete(runtime.networkId);
  }
}

/**
 * Powers off one network.
 *
 * This is the expected manual shutdown path for a network center: flush the
 * runtime into its cells, release cell ownership, delete the network record,
 * and remove the runtime cache entry. Stored cell items are preserved.
 *
 * @param {number} networkId Network id.
 * @returns {boolean} True when the network existed and was flushed.
 */
export function powerOffNetwork(networkId) {
  const runtime = getNetwork(networkId);
  if (!runtime) return false;

  runtime.state = "closing";
  runtime.online = false;
  runtime.dirty = true;

  const flushed = flushNetwork(runtime.networkId);
  if (!flushed) return false;

  const cellIds = [...runtime.cells.keys()];
  for (const cellId of cellIds) {
    if (!releaseCellNetwork(cellId, runtime.networkId)) {
      throw new Error(`Unable to release cell ${cellId} from network ${runtime.networkId}.`);
    }
  }

  deleteNetworkRecord(runtime.networkId);
  runtimeNetworks.delete(runtime.networkId);
  return true;
}

/**
 * Powers off every known network.
 *
 * This is a debug/admin shutdown path. It walks the persistent network index so
 * it also catches records that are not currently loaded in runtime cache. Stale
 * network ids without readable records are deleted from the index too.
 *
 * @returns {{poweredOff:number, networkIds:number[], stale:number}} Powered-off network ids.
 */
export function powerOffAllNetworks() {
  const networkIds = [];
  let stale = 0;

  for (const networkId of readNetworkIndex()) {
    if (powerOffNetwork(networkId)) {
      networkIds.push(networkId);
      continue;
    }
    if (deleteNetworkRecord(networkId)) stale += 1;
  }

  return {
    poweredOff: networkIds.length,
    networkIds,
    stale,
  };
}

/**
 * Flushes all runtime networks.
 *
 * Used on world shutdown. By default clean runtimes are skipped.
 *
 * @param {{onlyDirty?: boolean, syncDriveItems?: boolean}} [options]
 * @returns {number} Number of networks flushed.
 */
export function flushAllNetworks({ onlyDirty = true, syncDriveItems = true } = {}) {
  let flushed = 0;
  for (const runtime of runtimeNetworks.values()) {
    if (onlyDirty && !runtime.dirty) continue;
    if (flushNetwork(runtime.networkId, { syncDriveItems })) flushed += 1;
  }
  return flushed;
}

/**
 * Reloads one runtime network from persistent records.
 *
 * Useful for debug verification: flush, reload, print should produce the same
 * totals when persistence is correct.
 *
 * @param {number} networkId Network id.
 * @returns {object | undefined} Runtime network.
 */
export function reloadNetwork(networkId) {
  return loadNetwork(networkId);
}

/**
 * Starts the global staggered auto-flush loop.
 *
 * The loop checks one runtime network every 100 ticks. A dirty online network is
 * flushed only when at least 1200 ticks have passed since its previous
 * auto-flush, so several networks naturally spread their disk writes across
 * different ticks.
 *
 * @returns {number | undefined} Run interval id.
 */
export function startNetworkAutoFlush() {
  if (autoFlushRunId !== undefined) return autoFlushRunId;

  autoFlushRunId = system.runInterval(() => {
    const runtimes = [...runtimeNetworks.values()];
    if (runtimes.length === 0) return;

    const runtime = runtimes[autoFlushCursor % runtimes.length];
    autoFlushCursor = (autoFlushCursor + 1) % Math.max(1, runtimes.length);

    if (!runtime?.online || !runtime.dirty) return;
    if (activeFlushJobs.has(runtime.networkId)) return;

    const lastFlushTick = Math.floor(Number(runtime.lastAutoFlushTick) || 0);
    if (system.currentTick - lastFlushTick < AUTO_FLUSH_COOLDOWN_TICKS) return;

    runtime.lastAutoFlushTick = system.currentTick;
    const jobId = system.runJob(flushNetworkJob(runtime.networkId));
    activeFlushJobs.set(runtime.networkId, jobId);
  }, AUTO_FLUSH_INTERVAL_TICKS);

  return autoFlushRunId;
}
