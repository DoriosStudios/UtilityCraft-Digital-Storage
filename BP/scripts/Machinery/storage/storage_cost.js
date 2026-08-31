export const ITEMS_PER_STORAGE_UNIT = 8;
export const SIMPLE_TYPE_OVERHEAD_UNITS = 8;
export const DEFINED_TYPE_OVERHEAD_UNITS = 16;
export const OPAQUE_ITEM_UNITS = 64;

const DEFINED_ITEM_KEY_PREFIX = "ucds:item:";
const OPAQUE_ITEM_KEY_PREFIX = "ucds:vault:";

export function normalizeStorageAmount(value) {
  const amount = Math.floor(Number(value));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

export function getStorageKeyClass(itemKey) {
  const key = String(itemKey ?? "");
  if (key.startsWith(OPAQUE_ITEM_KEY_PREFIX)) return "opaque";
  if (key.startsWith(DEFINED_ITEM_KEY_PREFIX)) return "defined";
  return "simple";
}

export function getEntryStorageUnits(itemKey, amount) {
  const normalized = normalizeStorageAmount(amount);
  if (normalized <= 0) return 0;

  const keyClass = getStorageKeyClass(itemKey);
  if (keyClass === "opaque") {
    return normalized === 1 ? OPAQUE_ITEM_UNITS : Number.POSITIVE_INFINITY;
  }

  const overhead = keyClass === "defined"
    ? DEFINED_TYPE_OVERHEAD_UNITS
    : SIMPLE_TYPE_OVERHEAD_UNITS;
  return overhead + Math.ceil(normalized / ITEMS_PER_STORAGE_UNIT);
}

export function getEntryStorageDelta(itemKey, before, after) {
  const previous = getEntryStorageUnits(itemKey, before);
  const next = getEntryStorageUnits(itemKey, after);
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return Number.POSITIVE_INFINITY;
  return next - previous;
}

export function getEntriesStorageSummary(entries) {
  const iterable = entries instanceof Map ? entries.entries() : Object.entries(entries ?? {});
  let usedUnits = 0;
  let itemCount = 0;
  let typeCount = 0;

  for (const [itemKey, rawAmount] of iterable) {
    const amount = normalizeStorageAmount(rawAmount);
    if (!itemKey || amount <= 0) continue;
    const units = getEntryStorageUnits(itemKey, amount);
    if (!Number.isSafeInteger(units)) {
      return { valid: false, usedUnits: Number.POSITIVE_INFINITY, itemCount, typeCount };
    }
    if (!Number.isSafeInteger(itemCount + amount) || !Number.isSafeInteger(usedUnits + units)) {
      return { valid: false, usedUnits: Number.POSITIVE_INFINITY, itemCount, typeCount };
    }
    usedUnits += units;
    itemCount += amount;
    typeCount += 1;
  }

  return { valid: true, usedUnits, itemCount, typeCount };
}

export function getMaxInsertAmount(itemKey, before, freeUnits, requested) {
  const current = normalizeStorageAmount(before);
  const free = Math.max(0, Math.floor(Number(freeUnits) || 0));
  const wanted = normalizeStorageAmount(requested);
  if (wanted <= 0) return 0;

  if (getStorageKeyClass(itemKey) === "opaque") {
    return current === 0 && free >= OPAQUE_ITEM_UNITS ? 1 : 0;
  }

  const overhead = getStorageKeyClass(itemKey) === "defined"
    ? DEFINED_TYPE_OVERHEAD_UNITS
    : SIMPLE_TYPE_OVERHEAD_UNITS;
  let payloadBudget = free;
  if (current <= 0) {
    if (payloadBudget <= overhead) return 0;
    payloadBudget -= overhead;
    return Math.min(wanted, payloadBudget * ITEMS_PER_STORAGE_UNIT);
  }

  const currentPayloadUnits = Math.ceil(current / ITEMS_PER_STORAGE_UNIT);
  const maxFinal = (currentPayloadUnits + payloadBudget) * ITEMS_PER_STORAGE_UNIT;
  return Math.min(wanted, Math.max(0, maxFinal - current));
}
