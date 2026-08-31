import { world } from "@minecraft/server";
import { getCellId, isStorageCell } from "./cell_store.js";
import { DRIVE_SLOT_COUNT, getDriveEntity } from "./drive_cells.js";
import { formatCompactCount, formatStorageBytes, formatStoragePercent } from "./storage_format.js";

const CELL_MAX_DURABILITY = 1000;
const CELL_MIN_VISIBLE_DURABILITY = 50;
const CELL_MAX_VISIBLE_DURABILITY = 999;

function getCellLore(cell) {
  const used = Math.max(0, Math.floor(Number(cell?.usedUnits ?? cell?.used) || 0));
  const capacity = Math.max(0, Math.floor(Number(cell?.capacityUnits ?? cell?.capacity) || 0));

  return [
    `\u00A7r\u00A77Stored: \u00A7f${formatCompactCount(cell?.itemCount ?? 0)} Items`,
    `\u00A7r\u00A77Types: \u00A7f${formatCompactCount(cell?.typeCount ?? 0)} Item Types`,
    `\u00A7r\u00A77Storage: \u00A7f${formatStorageBytes(used)} / ${formatStorageBytes(capacity)} (${formatStoragePercent(used, capacity)}%)`,
  ];
}

function getDurability(item) {
  return item?.getComponent?.("durability") ?? item?.getComponent?.("minecraft:durability");
}

function getCellDamage(cell) {
  const used = Math.max(0, Math.floor(Number(cell?.usedUnits ?? cell?.used) || 0));
  if (used <= 0) return CELL_MAX_DURABILITY - CELL_MIN_VISIBLE_DURABILITY;

  const capacity = Math.max(0, Math.floor(Number(cell?.capacityUnits ?? cell?.capacity) || 0));
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

/**
 * Synchronizes one physical storage-cell ItemStack with its persistent record.
 *
 * @param {import("@minecraft/server").ItemStack | undefined} item Storage cell item.
 * @param {object | undefined} cell Persistent cell record.
 * @returns {boolean} True when lore or durability changed.
 */
export function syncCellItem(item, cell) {
  if (!isStorageCell(item) || !cell) return false;

  const loreChanged = syncCellLore(item, cell);
  const durabilityChanged = syncCellDurability(item, cell);
  return loreChanged || durabilityChanged;
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

    const changed = syncCellItem(item, cell);
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
