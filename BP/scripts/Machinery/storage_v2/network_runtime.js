import {
  allocateNetworkId,
  deleteNetworkRecord,
  readCellRecord,
  readNetworkIndex,
  readNetworkRecord,
  releaseCellNetwork,
  writeCellRecord,
  writeNetworkRecord,
} from "./cell_store.js";
import { createItemFromKey } from "./item_registry.js";

/**
 * Runtime network manager for Digital Storage V2.
 *
 * While a network is online, all item operations should go through this module.
 * It keeps fast in-memory maps and only persists to world dynamic properties at
 * explicit boundaries such as flush, power off, or world shutdown.
 */

const CHANGE_LIMIT = 64;
const UI_ELEMENT_TAG = "utilitycraft:ui_element";
const uiElementKeyCache = new Map();

function isUiElementKey(itemKey) {
  const key = String(itemKey ?? "");
  if (!key) return false;
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

    if (normalizedAmount <= 0) continue;

    const slot = reserveTerminalDisplaySlot(state);
    if (slot < 0) continue;

    state.renderedSlots.set(itemKey, slot);
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
  const totals = new Map();
  let capacity = 0;

  const cells = new Map();
  for (const cell of cellRecords) {
    if (!cell) continue;
    cells.set(cell.cellId, {
      cellId: cell.cellId,
      networkId: networkRecord.networkId,
      version: cell.version,
      capacity: cell.capacity,
      used: cell.used,
      items: toMap(cell.items),
    });
    capacity += cell.capacity;
    for (const [itemKey, amount] of Object.entries(cell.items ?? {})) {
      totals.set(itemKey, (totals.get(itemKey) ?? 0) + amount);
    }
  }

  return {
    networkId: networkRecord.networkId,
    online: networkRecord.online === true,
    dirty: false,
    cells,
    totals,
    used: sumMap(totals),
    capacity,
    version: Math.floor(Number(networkRecord.version ?? 0)),
    changeSeq: Math.floor(Number(networkRecord.changeSeq ?? 0)),
    changes: Array.isArray(networkRecord.changes) ? [...networkRecord.changes] : [],
    center: networkRecord.center,
    centers: new Set(networkRecord.centers ?? []),
    drives: new Set(networkRecord.drives ?? []),
    terminals: new Set(networkRecord.terminals ?? []),
    terminalDisplays: new Map(),
  };
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
  for (const networkId of readNetworkIndex()) {
    loadNetwork(networkId);
  }
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
      dirty: false,
      cells: new Map(),
      totals: new Map(),
      used: 0,
      capacity: 0,
      version: Math.floor(Number(record.version ?? 0)),
      changeSeq: Math.floor(Number(record.changeSeq ?? 0)),
      changes: Array.isArray(record.changes) ? [...record.changes] : [],
      center: record.center,
      centers: new Set(record.centers ?? []),
      drives: new Set(record.drives ?? []),
      terminals: new Set(record.terminals ?? []),
      terminalDisplays: new Map(),
    };

    for (const cellId of record.cells) {
      const cell = readCellRecord(cellId);
      cellsRead += 1;
      workDone += 1;

      if (cell && (!cell.networkId || cell.networkId === record.networkId)) {
        runtime.cells.set(cell.cellId, {
          cellId: cell.cellId,
          networkId: record.networkId,
          version: cell.version,
          capacity: cell.capacity,
          used: cell.used,
          items: toMap(cell.items),
        });
        runtime.capacity += cell.capacity;
        for (const [itemKey, amount] of Object.entries(cell.items ?? {})) {
          runtime.totals.set(itemKey, (runtime.totals.get(itemKey) ?? 0) + amount);
        }
      }

      if (workDone >= workLimit) {
        workDone = 0;
        yield;
      }
    }

    runtime.used = sumMap(runtime.totals);
    runtimeNetworks.set(record.networkId, runtime);
    loaded += 1;
  }

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
 * @param {{page?: number, visibleCount?: number, gridStart?: number, gridSize?: number}} [options]
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
    dirty: runtime.dirty,
    used: runtime.used,
    capacity: runtime.capacity,
    free: Math.max(0, runtime.capacity - runtime.used),
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
 * @param {{networkId?: number, online?: boolean, center?: string, centers?: string[], drives?: string[], terminals?: string[]}} [options]
 * @returns {object} Runtime network.
 */
export function createNetworkFromCellIds(cellIds, options = {}) {
  const networkId = Math.floor(Number(options.networkId) || 0) || allocateNetworkId();
  const uniqueCells = [...new Set(cellIds.map((id) => Math.floor(Number(id) || 0)).filter(Boolean))];
  const cells = [];

  for (const cellId of uniqueCells) {
    const cell = readCellRecord(cellId);
    if (!cell) continue;
    if (
      options.allowReassign !== true &&
      cell.networkId &&
      cell.networkId !== networkId
    ) {
      throw new Error(`Cell ${cellId} already belongs to network ${cell.networkId}.`);
    }
    const owned = writeCellRecord(cellId, {
      ...cell,
      networkId,
      version: cell.version,
    });
    cells.push(owned);
  }

  const capacity = cells.reduce((sum, cell) => sum + cell.capacity, 0);
  const used = cells.reduce((sum, cell) => sum + cell.used, 0);
  const record = writeNetworkRecord(networkId, {
    networkId,
    version: readNetworkRecord(networkId)?.version ?? 0,
    online: options.online !== false,
    center: options.center,
    centers: options.centers ?? [],
    drives: options.drives ?? [],
    terminals: options.terminals ?? [],
    cells: cells.map((cell) => cell.cellId),
    capacity,
    used,
    changeSeq: 0,
    changes: [],
  });

  return loadNetwork(record.networkId);
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
 * @returns {{inserted:number, remaining:number, before?:number, after?:number}}
 */
export function addItem(networkId, itemKey, amount, reason = "debug") {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  if (isUiElementKey(itemKey)) return { inserted: 0, remaining: requested };

  const runtime = getNetwork(networkId);
  if (!runtime || !runtime.online) {
    return { inserted: 0, remaining: requested };
  }

  const free = Math.max(0, runtime.capacity - runtime.used);
  const inserted = Math.min(requested, free);
  if (inserted <= 0) return { inserted: 0, remaining: requested };

  const before = Math.floor(Number(runtime.totals.get(itemKey) ?? 0));
  const after = before + inserted;
  runtime.totals.set(itemKey, after);
  runtime.used += inserted;
  runtime.dirty = true;
  pushChange(runtime, itemKey, before, after, reason);

  return { inserted, remaining: requested - inserted, before, after };
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
 * @returns {{removed:number, remaining:number, before?:number, after?:number}}
 */
export function removeItem(networkId, itemKey, amount, reason = "debug") {
  const runtime = getNetwork(networkId);
  if (!runtime || !runtime.online) return { removed: 0, remaining: Math.max(0, Math.floor(Number(amount) || 0)) };

  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  const before = Math.floor(Number(runtime.totals.get(itemKey) ?? 0));
  const removed = Math.min(requested, before);
  if (removed <= 0) return { removed: 0, remaining: requested, before, after: before };

  const after = before - removed;
  if (after > 0) runtime.totals.set(itemKey, after);
  else runtime.totals.delete(itemKey);
  runtime.used -= removed;
  runtime.dirty = true;
  pushChange(runtime, itemKey, before, after, reason);

  return { removed, remaining: requested - removed, before, after };
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
 * Items are repartitioned across the network cells by available capacity. The
 * exact physical cell containing an item may change, because the online network
 * is treated as one storage pool.
 *
 * @param {number} networkId Network id.
 * @returns {boolean} True when flushed.
 */
export function flushNetwork(networkId) {
  const runtime = getNetwork(networkId);
  if (!runtime) return false;

  const cellList = [...runtime.cells.values()].sort((a, b) => a.cellId - b.cellId);
  for (const cell of cellList) {
    cell.items = new Map();
    cell.used = 0;
  }

  for (const [itemKey, amount] of getSortedItems(runtime.networkId, "name")) {
    let remaining = amount;
    for (const cell of cellList) {
      if (remaining <= 0) break;
      const free = Math.max(0, cell.capacity - cell.used);
      if (free <= 0) continue;
      const moved = Math.min(free, remaining);
      cell.items.set(itemKey, (cell.items.get(itemKey) ?? 0) + moved);
      cell.used += moved;
      remaining -= moved;
    }
  }

  for (const cell of cellList) {
    const saved = writeCellRecord(cell.cellId, {
      networkId: runtime.networkId,
      version: cell.version,
      capacity: cell.capacity,
      used: cell.used,
      items: toObject(cell.items),
    });
    if (saved) cell.version = saved.version;
  }

  writeNetworkRecord(runtime.networkId, {
    networkId: runtime.networkId,
    version: runtime.version,
    online: runtime.online,
    center: runtime.center,
    centers: [...runtime.centers],
    drives: [...runtime.drives],
    terminals: [...runtime.terminals],
    cells: cellList.map((cell) => cell.cellId),
    used: runtime.used,
    capacity: runtime.capacity,
    changeSeq: runtime.changeSeq,
    changes: runtime.changes,
  });

  runtime.dirty = false;
  return true;
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

  runtime.online = false;
  runtime.dirty = true;

  const flushed = flushNetwork(runtime.networkId);
  if (!flushed) return false;

  const cellIds = [...runtime.cells.keys()];
  for (const cellId of cellIds) {
    releaseCellNetwork(cellId, runtime.networkId);
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
 * @returns {{poweredOff:number, networkIds:number[]}} Powered-off network ids.
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
 * @param {{onlyDirty?: boolean}} [options]
 * @returns {number} Number of networks flushed.
 */
export function flushAllNetworks({ onlyDirty = true } = {}) {
  let flushed = 0;
  for (const runtime of runtimeNetworks.values()) {
    if (onlyDirty && !runtime.dirty) continue;
    if (flushNetwork(runtime.networkId)) flushed += 1;
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
