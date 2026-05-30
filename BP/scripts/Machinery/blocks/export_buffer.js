import { system } from "@minecraft/server";
import { Machine } from "DoriosCore/index.js";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import { getItemKey, createItemFromKey } from "Machinery/storage/item_key.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import {
  addToNetwork,
  readNetworkRecord,
  removeFromNetwork,
} from "Machinery/storage/storage_db.js";

const FILTER_START = 0;
const FILTER_END = 8;
const OUTPUT_START = 9;
const OUTPUT_END = 35;
const UPGRADE_SLOT = 36;
const EXTRACT_INTERVAL_TICKS = 20;
const SPEED_AMOUNTS = [8, 16, 24, 32, 48, 64, 128, 192, 256];

function getExportBufferEntity(block) {
  return block.dimension
    .getEntitiesAtBlockLocation(block.location)
    .find((entity) => entity.typeId === "utilitycraft:export_buffer");
}

function getSpeedLevel(container) {
  const upgrade = container.getItem(UPGRADE_SLOT);
  if (!upgrade || upgrade.typeId !== "utilitycraft:speed_upgrade") return 0;
  return Math.max(0, Math.min(8, Math.floor(Number(upgrade.amount) || 0)));
}

function getExtractionAmount(container) {
  return SPEED_AMOUNTS[getSpeedLevel(container)] ?? SPEED_AMOUNTS[0];
}

function getFirstAvailableFilter(container, totals) {
  for (let slot = FILTER_START; slot <= FILTER_END; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;

    const itemKey = getItemKey(item);
    if (!itemKey) continue;

    const available = Math.floor(Number(totals?.[itemKey] ?? 0));
    if (available > 0) return { itemKey, available };
  }

  return undefined;
}

function getExportSpace(container, itemKey) {
  const sample = createItemFromKey(itemKey, 1);
  const maxAmount = Math.max(1, Math.floor(Number(sample.maxAmount) || 64));
  let space = 0;

  for (let slot = OUTPUT_START; slot <= OUTPUT_END; slot++) {
    const item = container.getItem(slot);
    if (!item) {
      space += maxAmount;
      continue;
    }

    if (getItemKey(item) !== itemKey) continue;
    space += Math.max(0, maxAmount - item.amount);
  }

  return space;
}

function addToExportSlots(container, itemKey, amount) {
  let remaining = Math.floor(Number(amount) || 0);
  if (remaining <= 0) return 0;

  const sample = createItemFromKey(itemKey, 1);
  const maxAmount = Math.max(1, Math.floor(Number(sample.maxAmount) || 64));

  for (let slot = OUTPUT_START; slot <= OUTPUT_END; slot++) {
    if (remaining <= 0) break;
    const item = container.getItem(slot);
    if (!item || getItemKey(item) !== itemKey) continue;

    const put = Math.min(remaining, Math.max(0, maxAmount - item.amount));
    if (put <= 0) continue;

    item.amount += put;
    container.setItem(slot, item);
    remaining -= put;
  }

  for (let slot = OUTPUT_START; slot <= OUTPUT_END; slot++) {
    if (remaining <= 0) break;
    if (container.getItem(slot)) continue;

    const put = Math.min(remaining, maxAmount);
    container.setItem(slot, createItemFromKey(itemKey, put));
    remaining -= put;
  }

  return remaining;
}

function flushExportBuffer(block, entity) {
  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  const networkId = getNetworkIdForBlock(block);
  const network = readNetworkRecord(networkId);
  if (!network) {
    updateNetworkAround(block);
    return;
  }

  const filter = getFirstAvailableFilter(container, network.totals ?? {});
  if (!filter) return;

  const space = getExportSpace(container, filter.itemKey);
  if (space <= 0) return;

  const requested = Math.min(getExtractionAmount(container), filter.available, space);
  if (requested <= 0) return;

  const remainingInNetwork = removeFromNetwork(networkId, filter.itemKey, requested);
  const extracted = requested - remainingInNetwork;
  if (extracted <= 0) return;

  const exportRemainder = addToExportSlots(container, filter.itemKey, extracted);
  if (exportRemainder > 0) {
    // Space is calculated up front, so this should only happen if the inventory
    // changed during the same tick. Put the remainder back instead of deleting it.
    // This keeps extraction lossless.
    const restoreRemainder = addToNetwork(networkId, filter.itemKey, exportRemainder);
    if (restoreRemainder > 0) {
      console.warn("Export Buffer could not restore an extraction remainder.");
    }
  }
}

DoriosAPI.register.blockComponent("export_buffer", {
  beforeOnPlayerPlace(e, { params: settings }) {
    const { block } = e;
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: "utilitycraft:export_buffer",
          name: "export_buffer",
          inventory_size: settings?.entity?.inventory_size ?? 37,
          input_range: settings?.entity?.input_range ?? [FILTER_START, FILTER_END],
          output_range: settings?.entity?.output_range ?? [OUTPUT_START, OUTPUT_END],
        },
      });
      entity.triggerEvent("utilitycraft:setup_inventory");
      entity.nameTag = "entity.utilitycraft:export_buffer.name";
      entity.setDynamicProperty("last_export_buffer_tick", system.currentTick ?? 0);
      updateNetworkAround(block);
    });
  },

  onTick({ block }) {
    const entity = getExportBufferEntity(block);
    if (!entity || !entity.isValid) return;

    const currentTick = system.currentTick ?? 0;
    const lastTick = Math.floor(Number(entity.getDynamicProperty("last_export_buffer_tick") ?? 0));
    if (currentTick - lastTick < EXTRACT_INTERVAL_TICKS) return;

    entity.setDynamicProperty("last_export_buffer_tick", currentTick);
    flushExportBuffer(block, entity);
  },

  onPlayerBreak(e) {
    updateNetworkAround(e.block);
    Machine.onDestroy(e);
  },
});
