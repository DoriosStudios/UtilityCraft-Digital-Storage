import * as DoriosLib from "DoriosLib/index.js";
import { registerFixedItemIO, spawnStorageMachine } from "../../../DigitalStorageCore/entities.js";
import { createItemFromKey, getItemKey } from "../item_registry.js";
import { getNetwork, removeItem } from "../network_runtime.js";

export const EXPORT_BUFFER_ENTITY_TYPE = "utilitycraft:export_buffer";

const NETWORK_ID_PROPERTY = "ucds:network_id";
const FILTER_START_SLOT = 0;
const FILTER_END_SLOT = 8;
const OUTPUT_START_SLOT = 9;
const OUTPUT_END_SLOT = 35;
const UPGRADE_SLOT = 36;
const FILTER_SLOTS = Array.from(
  { length: FILTER_END_SLOT - FILTER_START_SLOT + 1 },
  (_, index) => FILTER_START_SLOT + index,
);
const OUTPUT_SLOTS = Array.from(
  { length: OUTPUT_END_SLOT - OUTPUT_START_SLOT + 1 },
  (_, index) => OUTPUT_START_SLOT + index,
);
const SPEED_UPGRADE_ID = "utilitycraft:speed_upgrade";
const MAX_SPEED_UPGRADES = 8;

registerFixedItemIO(EXPORT_BUFFER_ENTITY_TYPE, FILTER_SLOTS, OUTPUT_SLOTS);

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
  return Math.min(OUTPUT_END_SLOT - OUTPUT_START_SLOT + 1, 1 + getSpeedUpgradeLevel(container));
}

function getNextEmptyOutputSlot(container) {
  for (let slot = OUTPUT_START_SLOT; slot <= OUTPUT_END_SLOT; slot++) {
    if (!container.getItem(slot)) return slot;
  }
  return -1;
}

function getFilterKeys(container) {
  const keys = [];
  const seen = new Set();

  for (let slot = FILTER_START_SLOT; slot <= FILTER_END_SLOT; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;

    const itemKey = getItemKey(item);
    if (!itemKey || seen.has(itemKey)) continue;

    keys.push(itemKey);
    seen.add(itemKey);
  }

  return keys;
}

function getMaxStackSize(itemKey) {
  const item = createItemFromKey(itemKey, 1);
  return Math.max(1, Math.floor(Number(item.maxAmount) || 64));
}

function tickExportBuffer(entity) {
  const networkId = getExportBufferNetworkId(entity);
  if (!networkId) return;

  const runtime = getNetwork(networkId);
  if (!runtime?.online) return;

  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  const filterKeys = getFilterKeys(container);
  if (filterKeys.length === 0) return;

  let filterIndex = 0;
  let processed = 0;
  const maxProcessed = getStacksPerTick(container);

  while (processed < maxProcessed) {
    const outputSlot = getNextEmptyOutputSlot(container);
    if (outputSlot < 0) return;

    let exported = false;
    while (filterIndex < filterKeys.length) {
      const itemKey = filterKeys[filterIndex];
      const available = Math.floor(Number(runtime.totals.get(itemKey)) || 0);
      if (available <= 0) {
        filterIndex += 1;
        continue;
      }

      const amount = Math.min(available, getMaxStackSize(itemKey));
      const result = removeItem(networkId, itemKey, amount, "export_buffer");
      if (result.removed <= 0) {
        filterIndex += 1;
        continue;
      }

      container.setItem(outputSlot, createItemFromKey(itemKey, result.removed));
      processed += 1;
      exported = true;

      if (result.after <= 0) filterIndex += 1;
      break;
    }

    if (!exported) return;
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
      inputSlots: FILTER_SLOTS,
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
