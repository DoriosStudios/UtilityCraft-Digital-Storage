import { world } from "@minecraft/server";
import { getCellId, isStorageCell } from "./cell_store.js";
import { DRIVE_SLOT_COUNT, getDriveEntity } from "./drive_cells.js";

const CELL_MAX_DURABILITY = 1000;
const CELL_MIN_VISIBLE_DURABILITY = 50;
const CELL_MAX_VISIBLE_DURABILITY = 999;

function formatStorageAmount(value) {
  const amount = Math.max(0, Math.floor(Number(value) || 0));
  if (amount >= 1000000000) return `${(amount / 1000000000).toFixed(1)}B`;
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return amount.toString();
}

function formatUsagePercent(used, capacity) {
  const max = Math.max(0, Math.floor(Number(capacity) || 0));
  if (max <= 0) return "0.0%";

  const percent = Math.max(0, Math.min(100, ((Number(used) || 0) / max) * 100));
  return `${percent.toFixed(1)}%`;
}

function getCellLore(cell) {
  const used = Math.max(0, Math.floor(Number(cell?.used) || 0));
  const capacity = Math.max(0, Math.floor(Number(cell?.capacity) || 0));
  const free = Math.max(0, capacity - used);

  return [
    `\u00A7r\u00A77- Stored: \u00A7f${formatStorageAmount(used)}`,
    `\u00A7r\u00A77- Usage: \u00A7f${formatUsagePercent(used, capacity)}`,
    `\u00A7r\u00A77- Free: \u00A7f${formatStorageAmount(free)}`,
  ];
}

function getDurability(item) {
  return item?.getComponent?.("durability") ?? item?.getComponent?.("minecraft:durability");
}

function getCellDamage(cell) {
  const used = Math.max(0, Math.floor(Number(cell?.used) || 0));
  if (used <= 0) return CELL_MAX_DURABILITY - CELL_MIN_VISIBLE_DURABILITY;

  const capacity = Math.max(0, Math.floor(Number(cell?.capacity) || 0));
  if (capacity <= 0) return CELL_MAX_DURABILITY - CELL_MIN_VISIBLE_DURABILITY;

  const usage = Math.max(0, Math.min(1, used / capacity));
  const visibleRange = CELL_MAX_VISIBLE_DURABILITY - CELL_MIN_VISIBLE_DURABILITY;
  const visibleDurability = CELL_MIN_VISIBLE_DURABILITY + Math.ceil(usage * visibleRange);
  return CELL_MAX_DURABILITY - Math.max(
    CELL_MIN_VISIBLE_DURABILITY,
    Math.min(CELL_MAX_VISIBLE_DURABILITY, visibleDurability),
  );
}

function shouldCellBeUnbreakable(durability, damage = durability?.damage) {
  const currentDamage = Math.floor(Number(damage) || 0);
  const maxDurability = Math.max(0, Math.floor(Number(durability?.maxDurability) || 0));
  return currentDamage <= 0 ||
    (maxDurability > 0 && currentDamage >= maxDurability - CELL_MIN_VISIBLE_DURABILITY);
}

function loreMatches(item, expectedLore) {
  const currentLore = item.getLore?.() ?? [];
  return (
    currentLore.length === expectedLore.length &&
    currentLore.every((line, index) => line === expectedLore[index])
  );
}

function syncCellLore(item, cell) {
  const expectedLore = getCellLore(cell);
  if (loreMatches(item, expectedLore)) return false;
  item.setLore(expectedLore);
  return true;
}

function syncCellDurability(item, cell) {
  const durability = getDurability(item);
  if (!durability) return false;

  const targetDamage = getCellDamage(cell);
  const targetUnbreakable = shouldCellBeUnbreakable(durability, targetDamage);
  let changed = false;

  try {
    if (!targetUnbreakable && durability.unbreakable) {
      durability.unbreakable = false;
      changed = true;
    }

    if (durability.damage !== targetDamage) {
      durability.damage = targetDamage;
      changed = true;
    }

    if (durability.unbreakable !== targetUnbreakable) {
      durability.unbreakable = targetUnbreakable;
      changed = true;
    }
  } catch {
    return false;
  }

  return changed;
}

function parseDriveKey(driveKey) {
  const raw = String(driveKey ?? "");
  const splitIndex = raw.lastIndexOf(":");
  if (splitIndex <= 0) return undefined;

  const dimensionId = raw.slice(0, splitIndex);
  const coords = raw.slice(splitIndex + 1).split(",");
  if (coords.length !== 3) return undefined;

  const location = {
    x: Math.floor(Number(coords[0])),
    y: Math.floor(Number(coords[1])),
    z: Math.floor(Number(coords[2])),
  };
  if (!Number.isFinite(location.x) || !Number.isFinite(location.y) || !Number.isFinite(location.z)) {
    return undefined;
  }

  return { dimensionId, location };
}

function getDimension(dimensionId) {
  try {
    return world.getDimension(dimensionId);
  } catch {}

  try {
    return world.getDimension(String(dimensionId).split(":").pop() || "overworld");
  } catch {
    return undefined;
  }
}

function syncDriveCellItems(driveKey, cellsById) {
  const parsed = parseDriveKey(driveKey);
  if (!parsed) return 0;

  const dimension = getDimension(parsed.dimensionId);
  if (!dimension) return 0;

  let block;
  try {
    block = dimension.getBlock(parsed.location);
  } catch {
    return 0;
  }

  const entity = getDriveEntity(block);
  const container = entity?.getComponent("minecraft:inventory")?.container;
  if (!container) return 0;

  let synced = 0;
  const size = Math.min(DRIVE_SLOT_COUNT, container.size);
  for (let slot = 0; slot < size; slot++) {
    const item = container.getItem(slot);
    if (!isStorageCell(item)) continue;

    const cellId = getCellId(item);
    const cell = cellsById.get(cellId);
    if (!cell) continue;

    const loreChanged = syncCellLore(item, cell);
    const durabilityChanged = syncCellDurability(item, cell);
    const changed = loreChanged || durabilityChanged;
    if (!changed) continue;

    container.setItem(slot, item);
    synced += 1;
  }

  return synced;
}

/**
 * Best-effort visual sync for physical storage cell items inside loaded drives.
 *
 * The persistent cell records are already correct before this runs. If a drive
 * is unloaded or unavailable, the sync is skipped and will be retried on a later
 * flush/tick path.
 *
 * @param {object} runtime Runtime network.
 * @param {Map<number, object>} cellsById Saved cell records keyed by cell id.
 * @returns {number} Number of physical cell items updated.
 */
export function syncNetworkDriveCellItems(runtime, cellsById) {
  if (!runtime || !cellsById || cellsById.size === 0) return 0;

  let synced = 0;
  for (const driveKey of runtime.drives ?? []) {
    synced += syncDriveCellItems(driveKey, cellsById);
  }
  return synced;
}
