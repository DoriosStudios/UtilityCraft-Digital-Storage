import { system, world } from "@minecraft/server";
import { createItemFromKey } from "./item_key.js";
import {
  readFillerRestoreData,
  restoreTaggedFiller,
  RESTORABLE_FILLER_TYPES,
} from "./filler_restore.js";
import { applyVirtualLore, readVirtualItemData } from "./virtual_item_codec.js";
import { readNetworkRecord, removeFromNetwork } from "./storage_db.js";
import { Terminal } from "Machinery/core/terminal.js";
import { readBlueprintData, syncBlueprintDataAtSlot } from "Machinery/core/blueprint.js";

const recentBlueprintSyncs = new Map();
const TERMINAL_ENTITY_TYPES = new Set([
  "utilitycraft:storage_terminal",
  "utilitycraft:crafting_terminal",
  "utilitycraft:blueprint_terminal",
]);
const STORAGE_START = 0;
const STORAGE_END = 224;
const STORAGE_FILLER = "utilitycraft:storage_filler";
const LORE_DISPLAY = "§r§7- Count: §f";

function getInventory(player) {
  return (player.getComponent("inventory") || player.getComponent("minecraft:inventory"))?.container;
}

function getBlueprintSignature(item) {
  const data = readBlueprintData(item);
  if (!data?.id) return "";
  return JSON.stringify({
    id: data.id,
    amount: data.amount,
    materials: data.materials,
    leftover: data.leftover,
  });
}

function syncBlueprintDataForPlayerSlot(player, slot, item) {
  const signature = getBlueprintSignature(item);
  if (!signature) return;

  const key = `${player.id ?? player.name}|${slot}`;
  if (recentBlueprintSyncs.get(key) === signature) return;

  recentBlueprintSyncs.set(key, signature);
  syncBlueprintDataAtSlot(player, slot, item);
  system.runTimeout(() => {
    if (recentBlueprintSyncs.get(key) === signature) recentBlueprintSyncs.delete(key);
  }, 20);
}

function getRenderedSlotMap(entity) {
  const raw = entity.getDynamicProperty("rendered_slot_keys");
  if (typeof raw !== "string" || raw.length === 0) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function restoreRenderedTerminalSlot(virtual, currentQtyHint = 1) {
  if (!virtual?.entityId || !Number.isInteger(virtual.slot)) return false;
  if (virtual.slot < STORAGE_START || virtual.slot > STORAGE_END) return false;

  let entity;
  try {
    entity = world.getEntity(virtual.entityId);
  } catch {
    return false;
  }
  if (!entity?.isValid || !TERMINAL_ENTITY_TYPES.has(entity.typeId)) return false;

  const inventory = entity.getComponent("minecraft:inventory")?.container;
  if (!inventory) return false;

  const renderedSlots = getRenderedSlotMap(entity);
  if (renderedSlots[virtual.itemKey] !== virtual.slot) return false;

  const current = inventory.getItem(virtual.slot);
  if (current && current.typeId !== STORAGE_FILLER) {
    const currentVirtual = readVirtualItemData(current);
    if (
      !currentVirtual ||
      currentVirtual.networkId !== virtual.networkId ||
      currentVirtual.itemKey !== virtual.itemKey
    ) {
      return false;
    }
  }

  const network = readNetworkRecord(virtual.networkId);
  const count = Number(network?.totals?.[virtual.itemKey] ?? 0);

  try {
    const requestedQty =
      Math.floor(Number(entity.getDynamicProperty("extract_quantity"))) ||
      Math.floor(Number(currentQtyHint)) ||
      1;
    const testItem = createItemFromKey(virtual.itemKey, 1);
    const maxStack = testItem.maxAmount ?? 64;
    const renderAmount = Math.max(1, Math.min(requestedQty, count, maxStack));
    const virtualItem = createItemFromKey(virtual.itemKey, renderAmount);
    const currentLore = virtualItem.getLore() || [];
    applyVirtualLore(
      virtualItem,
      [...currentLore, `${LORE_DISPLAY}${count}`],
      virtual.networkId,
      virtual.itemKey,
      { entityId: entity.id, slot: virtual.slot, count },
    );
    inventory.setItem(virtual.slot, virtualItem);
    Terminal.syncBlueprintDataAtSlot(entity, virtual.slot, virtualItem);
    return true;
  } catch {
    return false;
  }
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
    return true;
  }

  const virtual = readVirtualItemData(item);
  if (!virtual) return false;

  const amount = item.amount;
  inventory.setItem(slot, undefined);
  const remaining = removeFromNetwork(virtual.networkId, virtual.itemKey, amount);
  const extracted = amount - remaining;
  restoreRenderedTerminalSlot(virtual, amount);
  if (extracted <= 0) return true;

  const realItem = createItemFromKey(virtual.itemKey, extracted);
  const overflow = inventory.addItem(realItem);
  if (overflow) {
    if (slot >= 0 && slot < inventory.size && !inventory.getItem(slot)) {
      inventory.setItem(slot, overflow);
      syncBlueprintDataForPlayerSlot(player, slot, overflow);
    } else {
      player.dimension.spawnItem(overflow, player.location);
    }
  }
  player.playSound("random.pop");
  return true;
}

world.afterEvents.playerInventoryItemChange.subscribe(({ player, itemStack, slot }) => {
  if (resolveVirtualItem(player, itemStack, slot)) return;
  syncBlueprintDataForPlayerSlot(player, slot, itemStack);
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
  restoreRenderedTerminalSlot(virtual, item.amount);
  if (extracted <= 0) return;

  dimension.spawnItem(createItemFromKey(virtual.itemKey, extracted), location);
});
