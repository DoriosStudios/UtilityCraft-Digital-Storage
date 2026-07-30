import { world } from "@minecraft/server";
import { normalizeItemKey } from "./item_key.js";

export const CELL_ID_PROPERTY = "ucds_cell_id";
const NETWORK_CHANGE_LIMIT = 64;

export const CELL_CAPACITIES = {
  "utilitycraft:storage_cell": 1024,
  "utilitycraft:basic_storage_cell": 4096,
  "utilitycraft:advanced_storage_cell": 16384,
  "utilitycraft:expert_storage_cell": 65536,
  "utilitycraft:ultimate_storage_cell": 409600,
};

function readJson(key, fallback) {
  const raw = world.getDynamicProperty(key);
  if (typeof raw !== "string") return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  world.setDynamicProperty(key, JSON.stringify(value));
}

function normalizeItemAmounts(items) {
  const normalized = {};
  let changed = false;

  for (const key of Object.keys(items ?? {})) {
    const amount = Math.floor(Number(items[key]) || 0);
    if (amount <= 0) {
      changed = true;
      continue;
    }

    const normalizedKey = normalizeItemKey(key);
    if (normalizedKey !== key) changed = true;
    normalized[normalizedKey] = (normalized[normalizedKey] ?? 0) + amount;
  }

  return { items: normalized, changed };
}

function normalizeNetworkChanges(changes) {
  return Array.isArray(changes)
    ? changes.map((change) => change?.itemKey
      ? { ...change, itemKey: normalizeItemKey(change.itemKey) }
      : change)
    : [];
}

function nextId(key) {
  const current = Number(world.getDynamicProperty(key) ?? 1);
  const next = Number.isFinite(current) && current > 0 ? Math.floor(current) : 1;
  world.setDynamicProperty(key, next + 1);
  return next;
}

export function isStorageCell(item) {
  return !!item && Object.prototype.hasOwnProperty.call(CELL_CAPACITIES, item.typeId);
}

export function getCellKey(cellId) {
  return `ucds:cell:${cellId}`;
}

export function getNetworkKey(networkId) {
  return `ucds:network:${networkId}`;
}

export function allocateCellId() {
  return nextId("ucds:next_cell_id");
}

export function allocateNetworkId() {
  return nextId("ucds:next_network_id");
}

export function getCellId(item) {
  const value = item?.getDynamicProperty?.(CELL_ID_PROPERTY);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function ensureCellId(item) {
  if (!isStorageCell(item)) return undefined;

  let cellId = getCellId(item);
  if (!cellId) {
    cellId = allocateCellId();
    item.setDynamicProperty(CELL_ID_PROPERTY, cellId);
    item.setDynamicProperty("cell_data", undefined);
  }

  const existingRecord = getCellRecord(cellId);
  const capacity = CELL_CAPACITIES[item.typeId];
  if (!existingRecord) {
    writeCellRecord(cellId, {
      version: 0,
      capacity,
      used: 0,
      items: {},
    });
  } else if (Math.floor(Number(existingRecord.capacity ?? 0)) !== capacity) {
    writeCellRecord(cellId, {
      ...existingRecord,
      capacity,
      version: existingRecord.version ?? 0,
    });
  }

  return cellId;
}

export function getCellRecord(cellId) {
  if (!Number.isInteger(cellId) || cellId <= 0) return undefined;
  const record = readJson(getCellKey(cellId), undefined);
  if (!record || typeof record !== "object") return undefined;

  const normalized = normalizeItemAmounts(record.items ?? {});
  return {
    ...record,
    items: normalized.items,
    used: Object.values(normalized.items).reduce((sum, value) => sum + (Number(value) || 0), 0),
  };
}

export function writeCellRecord(cellId, record) {
  const normalized = normalizeItemAmounts(
    record?.items && typeof record.items === "object" ? record.items : {},
  );
  const items = normalized.items;
  let used = 0;

  for (const key of Object.keys(items)) {
    const amount = Math.floor(Number(items[key]) || 0);
    if (amount <= 0) {
      delete items[key];
    } else {
      items[key] = amount;
      used += amount;
    }
  }

  writeJson(getCellKey(cellId), {
    version: Math.floor(Number(record?.version ?? 0)) + 1,
    capacity: Math.floor(Number(record?.capacity ?? 0)),
    used,
    items,
  });
}

export function readCellData(item, create = false) {
  if (!isStorageCell(item)) return undefined;

  const capacity = CELL_CAPACITIES[item.typeId];
  const cellId = create ? ensureCellId(item) : getCellId(item);
  const record = cellId ? getCellRecord(cellId) : undefined;
  const items = record?.items && typeof record.items === "object" ? { ...record.items } : {};
  const totalItems = Object.values(items).reduce((sum, value) => sum + (Number(value) || 0), 0);

  return {
    cellId,
    items,
    totalItems,
    capacity: record?.capacity ?? capacity,
  };
}

export function writeCellData(item, data) {
  if (!isStorageCell(item)) return undefined;

  const cellId = ensureCellId(item);
  writeCellRecord(cellId, {
    capacity: CELL_CAPACITIES[item.typeId],
    items: data?.items ?? {},
    version: getCellRecord(cellId)?.version ?? 0,
  });
  return readCellData(item);
}

export function readNetworkRecord(networkId) {
  if (!Number.isInteger(networkId) || networkId <= 0) return undefined;
  const record = readJson(getNetworkKey(networkId), undefined);
  if (!record || typeof record !== "object") return undefined;

  const totals = normalizeItemAmounts(record.totals ?? {}).items;
  const changes = normalizeNetworkChanges(record.changes);

  return {
    ...record,
    core: typeof record.core === "string" ? record.core : undefined,
    cores: Array.isArray(record.cores) ? record.cores : [],
    online: record.online === true,
    blockCount: Math.max(0, Math.floor(Number(record.blockCount ?? 0))),
    baseRate: Math.max(0, Math.floor(Number(record.baseRate ?? 0))),
    rate: Math.max(0, Math.floor(Number(record.rate ?? 0))),
    energy: Math.max(0, Math.floor(Number(record.energy ?? 0))),
    energyCap: Math.max(0, Math.floor(Number(record.energyCap ?? 0))),
    totals,
    changes,
  };
}

export function readNetworkMeta(networkId) {
  if (!Number.isInteger(networkId) || networkId <= 0) return undefined;
  const record = readJson(getNetworkKey(networkId), undefined);
  if (!record || typeof record !== "object") return undefined;

  return {
    version: Math.floor(Number(record.version ?? 0)),
    cells: Array.isArray(record.cells) ? record.cells : [],
    drives: Array.isArray(record.drives) ? record.drives : [],
    terminals: Array.isArray(record.terminals) ? record.terminals : [],
    core: typeof record.core === "string" ? record.core : undefined,
    cores: Array.isArray(record.cores) ? record.cores : [],
    online: record.online === true,
    blockCount: Math.max(0, Math.floor(Number(record.blockCount ?? 0))),
    baseRate: Math.max(0, Math.floor(Number(record.baseRate ?? 0))),
    rate: Math.max(0, Math.floor(Number(record.rate ?? 0))),
    energy: Math.max(0, Math.floor(Number(record.energy ?? 0))),
    energyCap: Math.max(0, Math.floor(Number(record.energyCap ?? 0))),
    used: Math.floor(Number(record.used ?? 0)),
    capacity: Math.floor(Number(record.capacity ?? 0)),
    changeSeq: Math.floor(Number(record.changeSeq ?? 0)),
    changes: normalizeNetworkChanges(record.changes),
  };
}

export function writeNetworkRecord(networkId, record) {
  const totals = normalizeItemAmounts(
    record?.totals && typeof record.totals === "object" ? record.totals : {},
  ).items;
  const changes = normalizeNetworkChanges(record?.changes);

  writeJson(getNetworkKey(networkId), {
    version: Math.floor(Number(record?.version ?? 0)) + 1,
    cells: record?.cells ?? [],
    drives: record?.drives ?? [],
    terminals: record?.terminals ?? [],
    core: typeof record?.core === "string" ? record.core : undefined,
    cores: Array.isArray(record?.cores) ? record.cores : [],
    online: record?.online === true,
    blockCount: Math.max(0, Math.floor(Number(record?.blockCount ?? 0))),
    baseRate: Math.max(0, Math.floor(Number(record?.baseRate ?? 0))),
    rate: Math.max(0, Math.floor(Number(record?.rate ?? 0))),
    energy: Math.max(0, Math.floor(Number(record?.energy ?? 0))),
    energyCap: Math.max(0, Math.floor(Number(record?.energyCap ?? 0))),
    totals,
    used: Math.floor(Number(record?.used ?? 0)),
    capacity: Math.floor(Number(record?.capacity ?? 0)),
    changeSeq: Math.floor(Number(record?.changeSeq ?? 0)),
    changes: changes.slice(-NETWORK_CHANGE_LIMIT),
  });
}

function writeNetworkPowerState(networkId, previous, online, details = {}) {
  if (!previous) return undefined;

  const energy = Math.max(0, Math.floor(Number(details.energy ?? previous.energy ?? 0)));
  const energyCap = Math.max(0, Math.floor(Number(details.energyCap ?? previous.energyCap ?? 0)));
  const baseRate = Math.max(0, Math.floor(Number(details.baseRate ?? previous.baseRate ?? 0)));
  const rate = Math.max(0, Math.floor(Number(details.rate ?? previous.rate ?? 0)));
  const core = typeof details.core === "string" ? details.core : previous.core;
  const nextOnline = online === true;
  const stateChanged =
    previous.online !== nextOnline ||
    previous.energyCap !== energyCap ||
    previous.baseRate !== baseRate ||
    previous.rate !== rate ||
    previous.core !== core;

  if (!stateChanged) return previous;

  const changeState = previous.online !== nextOnline
    ? appendNetworkReload(previous, nextOnline ? "network_power_on" : "network_power_off")
    : {
      changeSeq: Math.floor(Number(previous?.changeSeq ?? 0)),
      changes: Array.isArray(previous?.changes) ? previous.changes.slice(-NETWORK_CHANGE_LIMIT) : [],
    };

  writeNetworkRecord(networkId, {
    ...previous,
    ...changeState,
    core,
    online: nextOnline,
    baseRate,
    rate,
    energy,
    energyCap,
    version: previous.version ?? 0,
  });

  return readNetworkRecord(networkId);
}

export function setNetworkPowerState(networkId, online, details = {}) {
  return writeNetworkPowerState(networkId, readNetworkRecord(networkId), online, details);
}

export function setNetworkPowerStateFromRecord(networkId, previous, online, details = {}) {
  return writeNetworkPowerState(networkId, previous, online, details);
}

function appendNetworkChange(previous, itemKey, before, after, reason) {
  itemKey = normalizeItemKey(itemKey);
  before = Math.floor(Number(before) || 0);
  after = Math.floor(Number(after) || 0);
  if (!itemKey || before === after) {
    return {
      changeSeq: Math.floor(Number(previous?.changeSeq ?? 0)),
      changes: Array.isArray(previous?.changes) ? previous.changes.slice(-NETWORK_CHANGE_LIMIT) : [],
    };
  }

  const changeSeq = Math.floor(Number(previous?.changeSeq ?? 0)) + 1;
  const changes = Array.isArray(previous?.changes) ? previous.changes.slice() : [];
  changes.push({
    seq: changeSeq,
    itemKey,
    before,
    after,
    reason,
  });

  return {
    changeSeq,
    changes: changes.slice(-NETWORK_CHANGE_LIMIT),
  };
}

function appendNetworkChanges(previous, entries) {
  let changeSeq = Math.floor(Number(previous?.changeSeq ?? 0));
  const changes = Array.isArray(previous?.changes) ? previous.changes.slice() : [];

  for (const entry of entries) {
    const itemKey = normalizeItemKey(entry?.itemKey);
    const before = Math.floor(Number(entry?.before) || 0);
    const after = Math.floor(Number(entry?.after) || 0);
    if (!itemKey || before === after) continue;

    changeSeq++;
    changes.push({
      seq: changeSeq,
      itemKey,
      before,
      after,
      reason: entry.reason,
    });
  }

  return {
    changeSeq,
    changes: changes.slice(-NETWORK_CHANGE_LIMIT),
  };
}

function appendNetworkReload(previous, reason) {
  const changeSeq = Math.floor(Number(previous?.changeSeq ?? 0)) + 1;
  const changes = Array.isArray(previous?.changes) ? previous.changes.slice() : [];
  changes.push({
    seq: changeSeq,
    reloadAll: true,
    reason,
  });

  return {
    changeSeq,
    changes: changes.slice(-NETWORK_CHANGE_LIMIT),
  };
}

export function rebuildNetworkTotals(networkId, cells, change) {
  const totals = {};
  let used = 0;
  let capacity = 0;

  for (const cellId of cells) {
    const record = getCellRecord(cellId);
    if (!record) continue;
    const normalized = normalizeItemAmounts(record.items ?? {});
    if (normalized.changed) {
      record.items = normalized.items;
      writeCellRecord(cellId, record);
    }
    capacity += Number(record.capacity) || 0;
    for (const key in normalized.items) {
      const amount = Number(normalized.items[key]) || 0;
      used += amount;
      totals[key] = (totals[key] ?? 0) + amount;
    }
  }

  const previous = readNetworkRecord(networkId) ?? {};
  const changeState = change?.reloadAll
    ? appendNetworkReload(previous, change.reason)
    : change
      ? appendNetworkChange(
        previous,
        change.itemKey,
        change.before,
        totals[change.itemKey] ?? 0,
        change.reason,
      )
      : appendNetworkChange(previous);
  writeNetworkRecord(networkId, {
    ...previous,
    ...changeState,
    totals,
    used,
    capacity,
    version: previous.version ?? 0,
  });

  return { totals, used, capacity };
}

function writeNetworkItemDelta(networkId, network, itemKey, before, after, amountDelta, reason) {
  itemKey = normalizeItemKey(itemKey);
  const totals = network?.totals && typeof network.totals === "object"
    ? Object.assign({}, network.totals)
    : {};
  after = Math.floor(Number(after) || 0);
  if (after <= 0) {
    delete totals[itemKey];
  } else {
    totals[itemKey] = after;
  }

  const changeState = appendNetworkChange(network, itemKey, before, after, reason);
  writeNetworkRecord(networkId, Object.assign({}, network, changeState, {
    totals,
    used: Math.max(0, Math.floor(Number(network?.used ?? 0)) + amountDelta),
    capacity: Math.floor(Number(network?.capacity ?? 0)),
    version: network?.version ?? 0,
  }));
}

export function removeFromNetwork(networkId, itemKey, amount) {
  itemKey = normalizeItemKey(itemKey);
  const network = readNetworkRecord(networkId);
  let remaining = Math.floor(Number(amount) || 0);
  if (!network || network.online === false || remaining <= 0) return remaining;
  const requested = remaining;
  const before = Number(network.totals?.[itemKey] ?? 0);

  for (const cellId of network.cells ?? []) {
    if (remaining <= 0) break;
    const record = getCellRecord(cellId);
    if (!record) continue;
    const normalized = normalizeItemAmounts(record.items ?? {});
    if (normalized.changed) record.items = normalized.items;
    const stored = Number(record.items?.[itemKey] ?? 0);
    if (stored <= 0) continue;

    const take = Math.min(stored, remaining);
    record.items[itemKey] = stored - take;
    remaining -= take;
    writeCellRecord(cellId, record);
  }

  if (remaining === requested) return remaining;

  const extracted = requested - remaining;
  writeNetworkItemDelta(
    networkId,
    network,
    itemKey,
    before,
    before - extracted,
    -extracted,
    "extract",
  );
  return remaining;
}

export function purgeItemFromNetwork(networkId, itemKey, reason = "purge") {
  itemKey = normalizeItemKey(itemKey);
  const network = readNetworkRecord(networkId);
  if (!network || !itemKey) return 0;

  const before = Math.floor(Number(network.totals?.[itemKey] ?? 0));
  if (before <= 0) return 0;

  let removed = 0;
  for (const cellId of network.cells ?? []) {
    const record = getCellRecord(cellId);
    if (!record) continue;

    const stored = Math.floor(Number(record.items?.[itemKey] ?? 0));
    if (stored <= 0) continue;

    delete record.items[itemKey];
    removed += stored;
    writeCellRecord(cellId, record);
  }

  if (removed <= 0) return 0;

  writeNetworkItemDelta(
    networkId,
    network,
    itemKey,
    before,
    Math.max(0, before - removed),
    -removed,
    reason,
  );
  return removed;
}

export function addToNetwork(networkId, itemKey, amount) {
  itemKey = normalizeItemKey(itemKey);
  const network = readNetworkRecord(networkId);
  let remaining = Math.floor(Number(amount) || 0);
  if (!network || network.online === false || remaining <= 0) return remaining;
  const requested = remaining;
  const before = Number(network.totals?.[itemKey] ?? 0);

  for (const cellId of network.cells ?? []) {
    if (remaining <= 0) break;
    const record = getCellRecord(cellId);
    if (!record) continue;
    const space = (Number(record.capacity) || 0) - (Number(record.used) || 0);
    if (space <= 0) continue;

    const put = Math.min(space, remaining);
    record.items[itemKey] = (Number(record.items[itemKey]) || 0) + put;
    remaining -= put;
    writeCellRecord(cellId, record);
  }

  if (remaining === requested) return remaining;

  const inserted = requested - remaining;
  writeNetworkItemDelta(
    networkId,
    network,
    itemKey,
    before,
    before + inserted,
    inserted,
    "insert",
  );
  return remaining;
}

export function addManyToNetwork(networkId, itemAmounts, reason = "insert") {
  const network = readNetworkRecord(networkId);
  const remainingByKey = {};
  if (!network || !itemAmounts || typeof itemAmounts !== "object") return remainingByKey;
  if (network.online === false) {
    for (const itemKey of Object.keys(itemAmounts)) {
      const normalizedKey = normalizeItemKey(itemKey);
      const amount = Math.floor(Number(itemAmounts[itemKey]) || 0);
      if (!normalizedKey || amount <= 0) continue;
      remainingByKey[normalizedKey] = (remainingByKey[normalizedKey] ?? 0) + amount;
    }
    return remainingByKey;
  }

  const requests = [];
  for (const itemKey of Object.keys(itemAmounts)) {
    const normalizedKey = normalizeItemKey(itemKey);
    const amount = Math.floor(Number(itemAmounts[itemKey]) || 0);
    if (!normalizedKey || amount <= 0) continue;
    const existingRequest = requests.find((request) => request.itemKey === normalizedKey);
    if (existingRequest) existingRequest.amount += amount;
    else requests.push({ itemKey: normalizedKey, amount });
    remainingByKey[normalizedKey] = (remainingByKey[normalizedKey] ?? 0) + amount;
  }
  if (requests.length === 0) return remainingByKey;

  const records = new Map();
  const dirtyCells = new Set();

  function getMutableCellRecord(cellId) {
    if (records.has(cellId)) return records.get(cellId);
    const record = getCellRecord(cellId);
    if (!record) return undefined;
    record.items = record.items && typeof record.items === "object" ? record.items : {};
    record.used = Math.floor(Number(record.used) || 0);
    record.capacity = Math.floor(Number(record.capacity) || 0);
    records.set(cellId, record);
    return record;
  }

  for (const { itemKey, amount } of requests) {
    let remaining = amount;
    for (const cellId of network.cells ?? []) {
      if (remaining <= 0) break;
      const record = getMutableCellRecord(cellId);
      if (!record) continue;

      const space = record.capacity - record.used;
      if (space <= 0) continue;

      const put = Math.min(space, remaining);
      record.items[itemKey] = (Number(record.items[itemKey]) || 0) + put;
      record.used += put;
      remaining -= put;
      dirtyCells.add(cellId);
    }
    remainingByKey[itemKey] = remaining;
  }

  if (dirtyCells.size === 0) return remainingByKey;

  for (const cellId of dirtyCells) {
    writeCellRecord(cellId, records.get(cellId));
  }

  const totals = network?.totals && typeof network.totals === "object"
    ? Object.assign({}, network.totals)
    : {};
  const changes = [];
  let insertedTotal = 0;

  for (const { itemKey, amount } of requests) {
    const inserted = amount - Math.floor(Number(remainingByKey[itemKey]) || 0);
    if (inserted <= 0) continue;

    const before = Math.floor(Number(network.totals?.[itemKey] ?? 0));
    const after = before + inserted;
    totals[itemKey] = after;
    insertedTotal += inserted;
    changes.push({ itemKey, before, after, reason });
  }

  if (insertedTotal <= 0) return remainingByKey;

  const changeState = appendNetworkChanges(network, changes);
  writeNetworkRecord(networkId, Object.assign({}, network, changeState, {
    totals,
    used: Math.max(0, Math.floor(Number(network?.used ?? 0)) + insertedTotal),
    capacity: Math.floor(Number(network?.capacity ?? 0)),
    version: network?.version ?? 0,
  }));

  return remainingByKey;
}
