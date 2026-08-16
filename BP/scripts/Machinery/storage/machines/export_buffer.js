import * as DoriosLib from "DoriosLib/index.js";
import { spawnStorageMachine } from "../../../DigitalStorageCore/entities.js";
import { createItemFromKey, getItemKey } from "../item_registry.js";
import { getNetwork, removeItem } from "../network_runtime.js";

export const EXPORT_BUFFER_ENTITY_TYPE = "utilitycraft:export_buffer";

const NETWORK_ID_PROPERTY = "ucds:network_id";
const FILTER_START_SLOT = 0;
const FILTER_END_SLOT = 8;
const OUTPUT_START_SLOT = 9;
const OUTPUT_END_SLOT = 35;
const OUTPUT_COLUMNS = FILTER_END_SLOT - FILTER_START_SLOT + 1;
const OUTPUT_ROWS = 3;
const UPGRADE_SLOT = 36;
const OUTPUT_SLOTS = Array.from(
  { length: OUTPUT_END_SLOT - OUTPUT_START_SLOT + 1 },
  (_, index) => OUTPUT_START_SLOT + index,
);
const SPEED_UPGRADE_ID = "utilitycraft:speed_upgrade";
const MAX_SPEED_UPGRADES = 8;

/**
 * Finds the helper entity backing an export buffer block.
 *
 * @param {import("@minecraft/server").Block | undefined} block Export buffer block.
 * @returns {import("@minecraft/server").Entity | undefined} Buffer entity.
 */
export function getExportBufferEntity(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === EXPORT_BUFFER_ENTITY_TYPE);
}

/**
 * Reads the linked storage network id from an export buffer entity.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Buffer entity.
 * @returns {number} Network id, or 0 when unlinked.
 */
export function getExportBufferNetworkId(entity) {
  const id = Math.floor(Number(entity?.getDynamicProperty?.(NETWORK_ID_PROPERTY)) || 0);
  return id > 0 ? id : 0;
}

/**
 * Links or unlinks an export buffer from a storage network.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Buffer entity.
 * @param {number} networkId Network id, or 0 to unlink.
 */
export function setExportBufferNetworkId(entity, networkId) {
  if (!entity?.isValid) return;

  const id = Math.floor(Number(networkId) || 0);
  entity.setDynamicProperty(NETWORK_ID_PROPERTY, id > 0 ? id : undefined);
}

function getSpeedUpgradeLevel(container) {
  const item = container.getItem(UPGRADE_SLOT);
  if (!item || item.typeId !== SPEED_UPGRADE_ID) return 0;
  return Math.max(0, Math.min(MAX_SPEED_UPGRADES, Math.floor(Number(item.amount) || 0)));
}

function getStacksPerTick(container) {
  return Math.min(OUTPUT_COLUMNS, 1 + getSpeedUpgradeLevel(container));
}

function getColumnOutputSlots(filterSlot) {
  const column = filterSlot - FILTER_START_SLOT;
  return Array.from(
    { length: OUTPUT_ROWS },
    (_, row) => OUTPUT_START_SLOT + column + row * OUTPUT_COLUMNS,
  );
}

function getColumnPlan(container, filterSlot, itemKey) {
  const probe = createItemFromKey(itemKey, 1);
  const maxAmount = Math.max(1, Math.floor(Number(probe.maxAmount) || 64));
  const slots = getColumnOutputSlots(filterSlot);
  let capacity = 0;

  for (const slot of slots) {
    const current = container.getItem(slot);
    if (!current) {
      capacity += maxAmount;
      continue;
    }
    if (current.isStackableWith(probe)) {
      capacity += Math.max(0, maxAmount - current.amount);
    }
  }

  return { maxAmount, probe, slots, capacity };
}

function insertIntoColumn(container, itemKey, plan, amount) {
  let remaining = Math.max(0, Math.floor(Number(amount) || 0));

  for (const slot of plan.slots) {
    if (remaining <= 0) break;
    const current = container.getItem(slot);
    if (!current || !current.isStackableWith(plan.probe)) continue;

    const moved = Math.min(remaining, Math.max(0, plan.maxAmount - current.amount));
    if (moved <= 0) continue;
    current.amount += moved;
    remaining -= moved;
    container.setItem(slot, current);
  }

  for (const slot of plan.slots) {
    if (remaining <= 0) break;
    if (container.getItem(slot)) continue;

    const moved = Math.min(remaining, plan.maxAmount);
    container.setItem(slot, createItemFromKey(itemKey, moved));
    remaining -= moved;
  }

  return remaining;
}

function tickExportBuffer(entity) {
  const networkId = getExportBufferNetworkId(entity);
  if (!networkId) return;

  const runtime = getNetwork(networkId);
  if (!runtime?.online) return;

  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  let processed = 0;
  const maxProcessed = getStacksPerTick(container);

  for (let filterSlot = FILTER_START_SLOT; filterSlot <= FILTER_END_SLOT; filterSlot++) {
    if (processed >= maxProcessed) break;

    const filterItem = container.getItem(filterSlot);
    if (!filterItem) continue;

    const itemKey = getItemKey(filterItem);
    if (!itemKey) continue;

    const available = Math.floor(Number(runtime.totals.get(itemKey)) || 0);
    if (available <= 0) continue;

    const plan = getColumnPlan(container, filterSlot, itemKey);
    const amount = Math.min(available, plan.maxAmount, plan.capacity);
    if (amount <= 0) continue;

    const result = removeItem(networkId, itemKey, amount, "export_buffer");
    if (result.removed <= 0) continue;

    insertIntoColumn(container, itemKey, plan, result.removed);
    processed += 1;
  }
}

function dropInventory(entity, block) {
  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  const dropLocation = block.center();
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;
    block.dimension.spawnItem(item, dropLocation);
    container.setItem(slot, undefined);
  }
}

DoriosLib.registry.blockComponent("utilitycraft:export_buffer", {
  beforeOnPlayerPlace(event, { params: settings }) {
    spawnStorageMachine(event, settings, {
      inputSlots: [],
      outputSlots: OUTPUT_SLOTS,
    }, (entity) => {
      entity.nameTag = "entity.utilitycraft:export_buffer.name";
    });
  },

  onTick({ block }) {
    const entity = getExportBufferEntity(block);
    if (!entity?.isValid) return;
    tickExportBuffer(entity);
  },

  onPlayerBreak({ block }) {
    const entity = getExportBufferEntity(block);
    if (!entity?.isValid) return;

    setExportBufferNetworkId(entity, 0);
    dropInventory(entity, block);
    entity.triggerEvent("despawn");
  },
});
