import { system, world } from "@minecraft/server";
import { isStorageCell } from "./storage_db.js";

function getInventory(player) {
  return (player.getComponent("inventory") || player.getComponent("minecraft:inventory"))?.container;
}

function getDurability(item) {
  return item?.getComponent("durability") ?? item?.getComponent("minecraft:durability");
}

function getCellDamageFromData(data) {
  const used = Math.max(0, Math.floor(Number(data?.totalItems ?? data?.used ?? 0) || 0));
  if (used <= 0) return 0;

  const capacity = Math.max(0, Math.floor(Number(data?.capacity) || 0));
  if (capacity <= 0) return 999;

  const usedDamageOffset = Math.ceil((used / capacity) * 999);
  return Math.max(1, Math.min(999, 1000 - usedDamageOffset));
}

export function syncCellDurabilityFromDamage(item) {
  if (!isStorageCell(item)) return false;

  const durability = getDurability(item);
  if (!durability) return false;

  const shouldBeUnbreakable = Math.floor(Number(durability.damage) || 0) <= 0;
  if (durability.unbreakable === shouldBeUnbreakable) return false;

  durability.unbreakable = shouldBeUnbreakable;
  return true;
}

export function syncCellDurabilityFromData(item, data) {
  if (!isStorageCell(item)) return false;

  const durability = getDurability(item);
  if (!durability) return false;

  const targetDamage = getCellDamageFromData(data);
  const targetUnbreakable = targetDamage <= 0;
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
