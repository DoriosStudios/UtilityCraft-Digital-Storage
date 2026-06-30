import { system, world } from "@minecraft/server";
import { isStorageCell } from "./storage_db.js";

const CELL_MAX_DURABILITY = 1000;
const CELL_MIN_VISIBLE_DURABILITY = 50;
const CELL_MAX_VISIBLE_DURABILITY = 999;

function getInventory(player) {
  return (player.getComponent("inventory") || player.getComponent("minecraft:inventory"))?.container;
}

function getDurability(item) {
  return item?.getComponent("durability") ?? item?.getComponent("minecraft:durability");
}

function getCellDamageFromData(data) {
  const used = Math.max(0, Math.floor(Number(data?.totalItems ?? data?.used ?? 0) || 0));
  if (used <= 0) return CELL_MAX_DURABILITY - CELL_MIN_VISIBLE_DURABILITY;

  const capacity = Math.max(0, Math.floor(Number(data?.capacity) || 0));
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

export function syncCellDurabilityFromDamage(item) {
  if (!isStorageCell(item)) return false;

  const durability = getDurability(item);
  if (!durability) return false;

  const shouldBeUnbreakable = shouldCellBeUnbreakable(durability);
  if (durability.unbreakable === shouldBeUnbreakable) return false;

  durability.unbreakable = shouldBeUnbreakable;
  return true;
}

export function syncCellDurabilityFromData(item, data) {
  if (!isStorageCell(item)) return false;

  const durability = getDurability(item);
  if (!durability) return false;

  const targetDamage = getCellDamageFromData(data);
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

function syncPlayerSlot(player, slot) {
  const inventory = getInventory(player);
  if (!inventory || slot < 0 || slot >= inventory.size) return;

  const item = inventory.getItem(slot);
  if (!syncCellDurabilityFromDamage(item)) return;

  inventory.setItem(slot, item);
}

world.afterEvents.playerInventoryItemChange.subscribe(({ player, beforeItemStack, itemStack, slot }) => {
  if (!isStorageCell(beforeItemStack) && !isStorageCell(itemStack)) return;

  system.run(() => syncPlayerSlot(player, slot));
});
