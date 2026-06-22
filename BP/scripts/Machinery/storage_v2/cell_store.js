import { world } from "@minecraft/server";

/**
 * Persistent storage layer for Digital Storage V2.
 *
 * This module is intentionally small and boring: it only knows how to read,
 * normalize, and write world dynamic property records. Runtime code should use
 * `network_runtime.js` for active operations and only come here for durable
 * records.
 */

export const CELL_ID_PROPERTY = "ucds_cell_id";
export const CELL_INDEX_KEY = "ucds:cell_index";
export const NETWORK_INDEX_KEY = "ucds:network_index";
export const CELL_RECORD_PREFIX = "ucds:cell:";
export const NETWORK_RECORD_PREFIX = "ucds:network:";

export const CELL_CAPACITIES = {
  "utilitycraft:storage_cell": 1024,
  "utilitycraft:basic_storage_cell": 4096,
  "utilitycraft:advanced_storage_cell": 16384,
  "utilitycraft:expert_storage_cell": 65536,
  "utilitycraft:ultimate_storage_cell": 409600,
};

const NETWORK_CHANGE_LIMIT = 64;

function readJson(key, fallback) {
  const raw = world.getDynamicProperty(key);
  if (typeof raw !== "string" || raw.length === 0) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  world.setDynamicProperty(key, JSON.stringify(value));
}

function deleteJson(key) {
  world.setDynamicProperty(key, undefined);
}

function normalizePositiveInt(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeAmountMap(items) {
  const normalized = {};
  let used = 0;

  for (const key of Object.keys(items ?? {})) {
    const amount = normalizePositiveInt(items[key]);
    if (amount <= 0) continue;
    normalized[key] = (normalized[key] ?? 0) + amount;
    used += amount;
  }

  return { items: normalized, used };
}

function readIndex(key) {
  const index = readJson(key, []);
  if (!Array.isArray(index)) return [];
  return [...new Set(index.map((id) => normalizePositiveInt(id)).filter(Boolean))];
}

function writeIndex(key, ids) {
  writeJson(key, [...new Set(ids.map((id) => normalizePositiveInt(id)).filter(Boolean))]);
}

function addToIndex(key, id) {
  const cleanId = normalizePositiveInt(id);
  if (!cleanId) return;
  const ids = readIndex(key);
  if (ids.includes(cleanId)) return;
  ids.push(cleanId);
  writeIndex(key, ids);
}

function removeFromIndex(key, id) {
  const cleanId = normalizePositiveInt(id);
  if (!cleanId) return;
  writeIndex(key, readIndex(key).filter((entry) => entry !== cleanId));
}

function nextId(key) {
  const current = normalizePositiveInt(world.getDynamicProperty(key), 1);
  world.setDynamicProperty(key, current + 1);
  return current;
}

export function getCellKey(cellId) {
  return `${CELL_RECORD_PREFIX}${cellId}`;
}

/**
 * Builds the world dynamic property key for a network record.
 *
 * @param {number} networkId Network id.
 * @returns {string} Dynamic property key.
 */
export function getNetworkKey(networkId) {
  return `${NETWORK_RECORD_PREFIX}${networkId}`;
}

/**
 * Checks whether an ItemStack is one of the supported storage cell items.
 *
 * @param {import("@minecraft/server").ItemStack | undefined} item Item to test.
 * @returns {boolean} True when the item is a storage cell.
 */
export function isStorageCell(item) {
  return !!item && Object.prototype.hasOwnProperty.call(CELL_CAPACITIES, item.typeId);
}

/**
 * Allocates a new persistent cell id and adds it to the cell index.
 *
 * @returns {number} New cell id.
 */
export function allocateCellId() {
  const cellId = nextId("ucds:next_cell_id");
  addToIndex(CELL_INDEX_KEY, cellId);
  return cellId;
}

/**
 * Allocates a new persistent network id and adds it to the network index.
 *
 * @returns {number} New network id.
 */
export function allocateNetworkId() {
  const networkId = nextId("ucds:next_network_id");
  addToIndex(NETWORK_INDEX_KEY, networkId);
  return networkId;
}

/**
 * Reads the known cell ids.
 *
 * @returns {number[]} Registered cell ids.
 */
export function readCellIndex() {
  return readIndex(CELL_INDEX_KEY);
}

/**
 * Reads the known network ids.
 *
 * @returns {number[]} Registered network ids.
 */
export function readNetworkIndex() {
  return readIndex(NETWORK_INDEX_KEY);
}

/**
 * Reads the cell id stored on a physical storage cell ItemStack.
 *
 * @param {import("@minecraft/server").ItemStack | undefined} item Storage cell.
 * @returns {number | undefined} Cell id, if present.
 */
export function getCellId(item) {
  const value = item?.getDynamicProperty?.(CELL_ID_PROPERTY);
  return normalizePositiveInt(value) || undefined;
}

/**
 * Reads and normalizes one persistent cell record.
 *
 * @param {number} cellId Cell id.
 * @returns {{version:number, cellId:number, networkId?:number, capacity:number, used:number, items:Record<string, number>} | undefined}
 */
export function readCellRecord(cellId) {
  const cleanId = normalizePositiveInt(cellId);
  if (!cleanId) return undefined;

  const record = readJson(getCellKey(cleanId), undefined);
  if (!record || typeof record !== "object") return undefined;

  const normalized = normalizeAmountMap(record.items);
  return {
    version: Math.floor(Number(record.version ?? 0)),
    cellId: cleanId,
    networkId: normalizePositiveInt(record.networkId) || undefined,
    capacity: Math.max(0, Math.floor(Number(record.capacity ?? 0))),
    used: normalized.used,
    items: normalized.items,
  };
}

/**
 * Writes one persistent cell record.
 *
 * `used` is recalculated from `items`; caller-provided stale `used` values are
 * ignored. The record version is incremented on every write.
 *
 * @param {number} cellId Cell id.
 * @param {object} record Cell record data.
 * @returns {object | undefined} Normalized record that was written.
 */
export function writeCellRecord(cellId, record) {
  const cleanId = normalizePositiveInt(cellId);
  if (!cleanId) return undefined;

  const normalized = normalizeAmountMap(record?.items);
  const capacity = Math.max(0, Math.floor(Number(record?.capacity ?? 0)));
  const nextRecord = {
    version: Math.floor(Number(record?.version ?? 0)) + 1,
    networkId: normalizePositiveInt(record?.networkId) || undefined,
    capacity,
    used: normalized.used,
    items: normalized.items,
  };

  writeJson(getCellKey(cleanId), nextRecord);
  addToIndex(CELL_INDEX_KEY, cleanId);
  return { cellId: cleanId, ...nextRecord };
}

/**
 * Removes network ownership from a cell while preserving its stored items.
 *
 * When `networkId` is provided, the cell is only released if it currently
 * belongs to that network. This prevents one network shutdown from detaching a
 * cell that was already reassigned by another path.
 *
 * @param {number} cellId Cell id.
 * @param {number} [networkId] Expected owner network id.
 * @returns {boolean} True when the cell was found and released.
 */
export function releaseCellNetwork(cellId, networkId) {
  const cell = readCellRecord(cellId);
  if (!cell) return false;

  const expectedNetworkId = normalizePositiveInt(networkId);
  if (expectedNetworkId && cell.networkId !== expectedNetworkId) return false;

  writeCellRecord(cell.cellId, {
    ...cell,
    networkId: undefined,
    version: cell.version,
  });
  return true;
}

/**
 * Ensures a physical storage cell item has a persistent cell id and matching
 * cell record.
 *
 * When `networkId` is provided, ownership is updated to that network. The item
 * should be written back into its container by the caller if this function
 * allocated a new id.
 *
 * @param {import("@minecraft/server").ItemStack} item Storage cell item.
 * @param {number} [networkId] Owning network id.
 * @returns {number | undefined} Cell id.
 */
export function ensureCellId(item, networkId) {
  if (!isStorageCell(item)) return undefined;

  let cellId = getCellId(item);
  if (!cellId) {
    cellId = allocateCellId();
    item.setDynamicProperty(CELL_ID_PROPERTY, cellId);
    item.setDynamicProperty("cell_data", undefined);
  } else {
    addToIndex(CELL_INDEX_KEY, cellId);
  }

  const capacity = CELL_CAPACITIES[item.typeId];
  const existing = readCellRecord(cellId);
  if (!existing) {
    writeCellRecord(cellId, {
      networkId,
      capacity,
      items: {},
    });
  } else if (existing.capacity !== capacity || (networkId && existing.networkId !== networkId)) {
    writeCellRecord(cellId, {
      ...existing,
      networkId: networkId || existing.networkId,
      capacity,
      version: existing.version,
    });
  }

  return cellId;
}

/**
 * Reads and normalizes one persistent network record.
 *
 * The network record stores topology/ownership metadata. Runtime totals are
 * rebuilt from the cells listed in this record.
 *
 * @param {number} networkId Network id.
 * @returns {object | undefined} Normalized network record.
 */
export function readNetworkRecord(networkId) {
  const cleanId = normalizePositiveInt(networkId);
  if (!cleanId) return undefined;

  const record = readJson(getNetworkKey(cleanId), undefined);
  if (!record || typeof record !== "object") return undefined;

  return {
    version: Math.floor(Number(record.version ?? 0)),
    networkId: cleanId,
    online: record.online === true,
    center: typeof record.center === "string" ? record.center : undefined,
    centers: Array.isArray(record.centers) ? record.centers : [],
    drives: Array.isArray(record.drives) ? record.drives : [],
    terminals: Array.isArray(record.terminals) ? record.terminals : [],
    cells: Array.isArray(record.cells)
      ? [...new Set(record.cells.map((id) => normalizePositiveInt(id)).filter(Boolean))]
      : [],
    used: Math.max(0, Math.floor(Number(record.used ?? 0))),
    capacity: Math.max(0, Math.floor(Number(record.capacity ?? 0))),
    changeSeq: Math.max(0, Math.floor(Number(record.changeSeq ?? 0))),
    changes: Array.isArray(record.changes) ? record.changes.slice(-NETWORK_CHANGE_LIMIT) : [],
  };
}

/**
 * Writes one persistent network record and updates the network index.
 *
 * The record version is incremented on every write.
 *
 * @param {number} networkId Network id.
 * @param {object} record Network record data.
 * @returns {object | undefined} Normalized record that was written.
 */
export function writeNetworkRecord(networkId, record) {
  const cleanId = normalizePositiveInt(networkId);
  if (!cleanId) return undefined;

  const nextRecord = {
    version: Math.floor(Number(record?.version ?? 0)) + 1,
    online: record?.online === true,
    center: typeof record?.center === "string" ? record.center : undefined,
    centers: Array.isArray(record?.centers) ? record.centers : [],
    drives: Array.isArray(record?.drives) ? record.drives : [],
    terminals: Array.isArray(record?.terminals) ? record.terminals : [],
    cells: Array.isArray(record?.cells)
      ? [...new Set(record.cells.map((id) => normalizePositiveInt(id)).filter(Boolean))]
      : [],
    used: Math.max(0, Math.floor(Number(record?.used ?? 0))),
    capacity: Math.max(0, Math.floor(Number(record?.capacity ?? 0))),
    changeSeq: Math.max(0, Math.floor(Number(record?.changeSeq ?? 0))),
    changes: Array.isArray(record?.changes)
      ? record.changes.slice(-NETWORK_CHANGE_LIMIT)
      : [],
  };

  writeJson(getNetworkKey(cleanId), nextRecord);
  addToIndex(NETWORK_INDEX_KEY, cleanId);
  return { networkId: cleanId, ...nextRecord };
}

/**
 * Deletes one persistent network record and removes it from the network index.
 *
 * Cell records are intentionally left untouched. Call `releaseCellNetwork` for
 * the cells that should become portable again.
 *
 * @param {number} networkId Network id.
 * @returns {boolean} True when the id was valid.
 */
export function deleteNetworkRecord(networkId) {
  const cleanId = normalizePositiveInt(networkId);
  if (!cleanId) return false;

  deleteJson(getNetworkKey(cleanId));
  removeFromIndex(NETWORK_INDEX_KEY, cleanId);
  return true;
}
