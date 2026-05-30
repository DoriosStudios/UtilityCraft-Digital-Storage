import { system, world } from "@minecraft/server";
import { createItemFromKey } from "./item_key.js";
import {
  readFillerRestoreData,
  restoreTaggedFiller,
  RESTORABLE_FILLER_TYPES,
} from "./filler_restore.js";
import { readVirtualItemData } from "./virtual_item_codec.js";
import { removeFromNetwork } from "./storage_db.js";

function getInventory(player) {
  return (player.getComponent("inventory") || player.getComponent("minecraft:inventory"))?.container;
}

function resolveVirtualItem(player, item, slot) {
  if (!item) return;

  const inventory = getInventory(player);
  if (!inventory) return;

  if (RESTORABLE_FILLER_TYPES.has(item.typeId)) {
    const fillerRestore = readFillerRestoreData(item);
    inventory.setItem(slot, undefined);
    if (fillerRestore) {
      system.run(() => restoreTaggedFiller(fillerRestore));
    }
    return;
  }

  const virtual = readVirtualItemData(item);
  if (!virtual) return;

  const amount = item.amount;
  inventory.setItem(slot, undefined);
  const remaining = removeFromNetwork(virtual.networkId, virtual.itemKey, amount);
  const extracted = amount - remaining;
  if (extracted <= 0) return;

  const realItem = createItemFromKey(virtual.itemKey, extracted);
  const overflow = inventory.addItem(realItem);
  if (overflow) player.dimension.spawnItem(overflow, player.location);
  player.playSound("random.pop");
}

world.afterEvents.playerInventoryItemChange.subscribe(({ player, itemStack, slot }) => {
  resolveVirtualItem(player, itemStack, slot);
});

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (!entity || !entity.isValid || entity.typeId !== "minecraft:item") return;

  let item;
  let dimension;
  let location;
  try {
    item = entity.getComponent("minecraft:item")?.itemStack;
    dimension = entity.dimension;
    location = entity.location;
  } catch {
    return;
  }
  if (!item) return;

  const fillerRestore = readFillerRestoreData(item);
  const virtual = readVirtualItemData(item);
  if (!virtual && !RESTORABLE_FILLER_TYPES.has(item.typeId)) return;

  try {
    if (entity.isValid) entity.remove();
  } catch {}

  if (fillerRestore) {
    system.run(() => restoreTaggedFiller(fillerRestore));
  }

  if (!virtual) return;

  const remaining = removeFromNetwork(virtual.networkId, virtual.itemKey, item.amount);
  const extracted = item.amount - remaining;
  if (extracted <= 0) return;

  dimension.spawnItem(createItemFromKey(virtual.itemKey, extracted), location);
});
