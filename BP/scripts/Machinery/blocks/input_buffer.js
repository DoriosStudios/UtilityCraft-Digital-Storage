import { system } from "@minecraft/server";
import { Machine } from "DoriosCore/index.js";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import { getItemKey } from "Machinery/storage/item_key.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import {
  addManyToNetwork,
  readNetworkRecord,
} from "Machinery/storage/storage_db.js";

const SLOT_START = 0;
const SLOT_END = 26;
const INSERT_INTERVAL_TICKS = 40;

function getInputBufferEntity(block) {
  return block.dimension
    .getEntitiesAtBlockLocation(block.location)
    .find((entity) => entity.typeId === "utilitycraft:input_buffer");
}

function consumeFromSlots(container, slots, amount) {
  let remaining = Math.floor(Number(amount) || 0);
  if (remaining <= 0) return;

  for (const slot of slots) {
    if (remaining <= 0) break;
    const item = container.getItem(slot);
    if (!item) continue;

    const take = Math.min(item.amount, remaining);
    remaining -= take;

    if (take >= item.amount) {
      container.setItem(slot, undefined);
    } else {
      item.amount -= take;
      container.setItem(slot, item);
    }
  }
}

function collectInsertBatch(container) {
  const amounts = {};
  const slotsByKey = {};

  for (let slot = SLOT_START; slot <= SLOT_END; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;

    const itemKey = getItemKey(item);
    if (!itemKey) continue;

    amounts[itemKey] = (amounts[itemKey] ?? 0) + item.amount;
    (slotsByKey[itemKey] ??= []).push(slot);
  }

  return { amounts, slotsByKey };
}

function flushInputBuffer(block, entity) {
  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  const { amounts, slotsByKey } = collectInsertBatch(container);
  if (Object.keys(amounts).length === 0) return;

  const networkId = getNetworkIdForBlock(block);
  const network = readNetworkRecord(networkId);
  if (!network || !Array.isArray(network.cells) || network.cells.length === 0) {
    updateNetworkAround(block);
    return;
  }

  const remainingByKey = addManyToNetwork(networkId, amounts, "input_buffer");
  for (const itemKey of Object.keys(amounts)) {
    const inserted = amounts[itemKey] - Math.floor(Number(remainingByKey[itemKey]) || 0);
    if (inserted > 0) consumeFromSlots(container, slotsByKey[itemKey] ?? [], inserted);
  }
}

DoriosAPI.register.blockComponent("input_buffer", {
  beforeOnPlayerPlace(e, { params: settings }) {
    const { block } = e;
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: "utilitycraft:input_buffer",
          name: "input_buffer",
          inventory_size: settings?.entity?.inventory_size ?? 27,
          input_range: settings?.entity?.input_range ?? [SLOT_START, SLOT_END],
          output_range: settings?.entity?.output_range ?? [-1, -1],
        },
      });
      entity.triggerEvent("utilitycraft:setup_inventory");
      entity.nameTag = "entity.utilitycraft:input_buffer.name";
      entity.setDynamicProperty("last_input_buffer_tick", system.currentTick ?? 0);
      updateNetworkAround(block);
    });
  },

  onTick({ block }) {
    const entity = getInputBufferEntity(block);
    if (!entity || !entity.isValid) return;

    const currentTick = system.currentTick ?? 0;
    const lastTick = Math.floor(Number(entity.getDynamicProperty("last_input_buffer_tick") ?? 0));
    if (currentTick - lastTick < INSERT_INTERVAL_TICKS) return;

    entity.setDynamicProperty("last_input_buffer_tick", currentTick);
    flushInputBuffer(block, entity);
  },

  onPlayerBreak(e) {
    updateNetworkAround(e.block);
    Machine.onDestroy(e);
  },
});
