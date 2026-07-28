import * as DoriosLib from "DoriosLib/index.js";
import { registerFixedItemIO, spawnStorageMachine } from "../../../DigitalStorageCore/entities.js";
import { getItemKey } from "../item_registry.js";
import { addItem, getNetwork } from "../network_runtime.js";

export const IMPORT_BUFFER_ENTITY_TYPE = "utilitycraft:import_buffer";

const NETWORK_ID_PROPERTY = "ucds:network_id";
const INPUT_START_SLOT = 0;
const INPUT_END_SLOT = 17;
const UPGRADE_SLOT = 18;
const INPUT_SLOTS = Array.from(
  { length: INPUT_END_SLOT - INPUT_START_SLOT + 1 },
  (_, index) => INPUT_START_SLOT + index,
);
const SPEED_UPGRADE_ID = "utilitycraft:speed_upgrade";
const MAX_SPEED_UPGRADES = 8;

registerFixedItemIO(IMPORT_BUFFER_ENTITY_TYPE, INPUT_SLOTS, []);

/**
 * Finds the helper entity backing an import buffer block.
 *
 * @param {import("@minecraft/server").Block | undefined} block Import buffer block.
 * @returns {import("@minecraft/server").Entity | undefined} Buffer entity.
 */
export function getImportBufferEntity(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === IMPORT_BUFFER_ENTITY_TYPE);
}

/**
 * Reads the linked storage network id from an import buffer entity.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Buffer entity.
 * @returns {number} Network id, or 0 when unlinked.
 */
export function getImportBufferNetworkId(entity) {
  const id = Math.floor(Number(entity?.getDynamicProperty?.(NETWORK_ID_PROPERTY)) || 0);
  return id > 0 ? id : 0;
}

/**
 * Links or unlinks an import buffer from a storage network.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Buffer entity.
 * @param {number} networkId Network id, or 0 to unlink.
 */
export function setImportBufferNetworkId(entity, networkId) {
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
  return Math.min(INPUT_END_SLOT - INPUT_START_SLOT + 1, 1 + getSpeedUpgradeLevel(container));
}

function tickImportBuffer(entity) {
  const networkId = getImportBufferNetworkId(entity);
  if (!networkId) return;

  const runtime = getNetwork(networkId);
  if (!runtime?.online) return;

  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  let processed = 0;
  const maxProcessed = getStacksPerTick(container);

  for (let slot = INPUT_START_SLOT; slot <= INPUT_END_SLOT; slot++) {
    if (processed >= maxProcessed) break;

    const item = container.getItem(slot);
    if (!item) continue;

    const itemKey = getItemKey(item);
    if (!itemKey) continue;

    const result = addItem(networkId, itemKey, item.amount, "import_buffer");
    if (result.inserted <= 0) break;

    processed += 1;
    if (result.remaining <= 0) {
      container.setItem(slot, undefined);
      continue;
    }

    item.amount = result.remaining;
    container.setItem(slot, item);
    break;
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

DoriosLib.registry.blockComponent("utilitycraft:import_buffer", {
  beforeOnPlayerPlace(event, { params: settings }) {
    spawnStorageMachine(event, settings, {
      inputSlots: INPUT_SLOTS,
      outputSlots: [],
    }, (entity) => {
      entity.nameTag = "entity.utilitycraft:import_buffer.name";
    });
  },

  onTick({ block }) {
    const entity = getImportBufferEntity(block);
    if (!entity?.isValid) return;
    tickImportBuffer(entity);
  },

  onPlayerBreak({ block }) {
    const entity = getImportBufferEntity(block);
    if (!entity?.isValid) return;

    setImportBufferNetworkId(entity, 0);
    dropInventory(entity, block);
    entity.triggerEvent("despawn");
  },
});
