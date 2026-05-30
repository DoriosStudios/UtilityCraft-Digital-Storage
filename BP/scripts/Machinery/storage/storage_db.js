import { world } from "@minecraft/server";

export const CELL_ID_PROPERTY = "ucds_cell_id";
const NETWORK_CHANGE_LIMIT = 64;

export const CELL_CAPACITIES = {
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
  return readJson(getCellKey(cellId), undefined);
}

export function writeCellRecord(cellId, record) {
  const items = record?.items && typeof record.items === "object" ? record.items : {};
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
  return readJson(getNetworkKey(networkId), undefined);
}

export function writeNetworkRecord(networkId, record) {
  writeJson(getNetworkKey(networkId), {
    version: Math.floor(Number(record?.version ?? 0)) + 1,
    cells: record?.cells ?? [],
    drives: record?.drives ?? [],
    terminals: record?.terminals ?? [],
    totals: record?.totals ?? {},
    used: Math.floor(Number(record?.used ?? 0)),
    capacity: Math.floor(Number(record?.capacity ?? 0)),
    changeSeq: Math.floor(Number(record?.changeSeq ?? 0)),
    changes: Array.isArray(record?.changes) ? record.changes.slice(-NETWORK_CHANGE_LIMIT) : [],
  });
}

function appendNetworkChange(previous, itemKey, before, after, reason) {
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
    const before = Math.floor(Number(entry?.before) || 0);
    const after = Math.floor(Number(entry?.after) || 0);
    if (!entry?.itemKey || before === after) continue;

    changeSeq++;
    changes.push({
      seq: changeSeq,
      itemKey: entry.itemKey,
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
    capacity += Number(record.capacity) || 0;
    used += Number(record.used) || 0;
    for (const key in record.items ?? {}) {
      totals[key] = (totals[key] ?? 0) + (Number(record.items[key]) || 0);
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
  const network = readNetworkRecord(networkId);
  let remaining = Math.floor(Number(amount) || 0);
  if (!network || remaining <= 0) return remaining;
  const requested = remaining;
  const before = Number(network.totals?.[itemKey] ?? 0);

  for (const cellId of network.cells ?? []) {
    if (remaining <= 0) break;
    const record = getCellRecord(cellId);
    const stored = Number(record?.items?.[itemKey] ?? 0);
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

export function addToNetwork(networkId, itemKey, amount) {
  const network = readNetworkRecord(networkId);
  let remaining = Math.floor(Number(amount) || 0);
  if (!network || remaining <= 0) return remaining;
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

  const requests = [];
  for (const itemKey of Object.keys(itemAmounts)) {
    const amount = Math.floor(Number(itemAmounts[itemKey]) || 0);
    if (!itemKey || amount <= 0) continue;
    requests.push({ itemKey, amount });
    remainingByKey[itemKey] = amount;
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
