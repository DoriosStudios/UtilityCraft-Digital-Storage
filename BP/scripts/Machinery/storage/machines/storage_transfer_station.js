import * as DoriosLib from "DoriosLib/index.js";
import { MachineUpgradeRegistry, TickScheduler } from "DoriosCore/index.js";
import { spawnStorageMachine } from "../../../DigitalStorageCore/entities.js";
import { syncCellItem } from "../cell_item_sync.js";
import {
  ensureCellId,
  getCellId,
  isStorageCell,
  readCellRecord,
  writeCellRecord,
} from "../cell_store.js";
import { getNetwork } from "../network_runtime.js";

export const STORAGE_TRANSFER_STATION_ENTITY_TYPE = "utilitycraft:storage_transfer_station";

const SOURCE_SLOT = 0;
const DESTINATION_SLOT = 1;
const SPEED_UPGRADE_SLOT = 2;
const UPGRADE_SLOTS = [SPEED_UPGRADE_SLOT];
const BASE_TRANSFER_PER_TICK = 500;
const TRANSFER_PER_SPEED_LEVEL = 500;

/**
 * Reads the installed Speed Upgrade level from the dedicated upgrade slot.
 *
 * @param {import("@minecraft/server").Container} container Machine inventory.
 * @returns {number} Installed upgrade level, from 0 through 8.
 */
function getSpeedUpgradeLevel(container) {
  const boosts = MachineUpgradeRegistry.resolveBoosts(container, UPGRADE_SLOTS, {
    speed_level: 0,
  });
  return Math.max(0, Math.floor(Number(boosts.speed_level) || 0));
}

/**
 * Returns the maximum amount transferred by the current 10-tick operation.
 *
 * @param {import("@minecraft/server").Container} container Machine inventory.
 * @returns {number} Transfer limit for this operation.
 */
function getTransferLimit(container) {
  return BASE_TRANSFER_PER_TICK
    + getSpeedUpgradeLevel(container) * TRANSFER_PER_SPEED_LEVEL;
}

/**
 * Finds the helper entity bound to a Storage Transfer Station block.
 *
 * @param {import("@minecraft/server").Block | undefined} block Storage Transfer Station block.
 * @returns {import("@minecraft/server").Entity | undefined} Backing entity.
 */
export function getStorageTransferStationEntity(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === STORAGE_TRANSFER_STATION_ENTITY_TYPE);
}

/**
 * Ensures the cell in one slot has an id/record and updates its visible usage.
 *
 * @param {import("@minecraft/server").Container} container Machine inventory.
 * @param {number} slot Cell slot.
 * @returns {{item:import("@minecraft/server").ItemStack, cellId:number, record:object} | undefined}
 */
function readCellSlot(container, slot) {
  const item = container.getItem(slot);
  if (!isStorageCell(item)) return undefined;

  const previousId = getCellId(item);
  const cellId = ensureCellId(item);
  if (!cellId) return undefined;

  const record = readCellRecord(cellId);
  if (!record) return undefined;

  const visualChanged = syncCellItem(item, record);
  if (!previousId || visualChanged) container.setItem(slot, item);
  return { item, cellId, record };
}

/**
 * Cells owned by an online network must not be changed behind its runtime cache.
 *
 * @param {object} record Cell record.
 * @returns {boolean} True when the owning network is online.
 */
function belongsToOnlineNetwork(record) {
  if (!record?.networkId) return false;
  return getNetwork(record.networkId)?.online === true;
}

/**
 * Moves the current upgrade-adjusted batch from slot 0 into slot 1.
 *
 * @param {import("@minecraft/server").Entity} entity Storage Transfer Station entity.
 * @returns {number} Amount transferred.
 */
function transferCellData(entity) {
  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return 0;

  const source = readCellSlot(container, SOURCE_SLOT);
  const destination = readCellSlot(container, DESTINATION_SLOT);
  if (!source || !destination || source.cellId === destination.cellId) return 0;
  if (source.record.used <= 0) return 0;
  if (belongsToOnlineNetwork(source.record) || belongsToOnlineNetwork(destination.record)) return 0;

  const destinationFree = Math.max(0, destination.record.capacity - destination.record.used);
  let remainingBatch = Math.min(getTransferLimit(container), source.record.used, destinationFree);
  if (remainingBatch <= 0) return 0;

  const sourceItems = { ...source.record.items };
  const destinationItems = { ...destination.record.items };
  let moved = 0;

  for (const [itemKey, rawAmount] of Object.entries(sourceItems)) {
    if (remainingBatch <= 0) break;

    const available = Math.max(0, Math.floor(Number(rawAmount) || 0));
    if (available <= 0) continue;

    const transfer = Math.min(available, remainingBatch);
    const sourceRemaining = available - transfer;
    if (sourceRemaining > 0) sourceItems[itemKey] = sourceRemaining;
    else delete sourceItems[itemKey];

    destinationItems[itemKey] = (destinationItems[itemKey] ?? 0) + transfer;
    moved += transfer;
    remainingBatch -= transfer;
  }

  if (moved <= 0) return 0;

  let savedDestination;
  let savedSource;
  try {
    savedDestination = writeCellRecord(destination.cellId, {
      ...destination.record,
      version: destination.record.version,
      items: destinationItems,
    });
    if (!savedDestination) return 0;

    savedSource = writeCellRecord(source.cellId, {
      ...source.record,
      version: source.record.version,
      items: sourceItems,
    });
    if (!savedSource) throw new Error("Unable to save source storage cell");
  } catch {
    if (savedDestination) {
      writeCellRecord(destination.cellId, {
        ...destination.record,
        version: savedDestination.version,
        items: destination.record.items,
      });
    }
    return 0;
  }

  syncCellItem(source.item, savedSource);
  syncCellItem(destination.item, savedDestination);
  container.setItem(SOURCE_SLOT, source.item);
  container.setItem(DESTINATION_SLOT, destination.item);
  return moved;
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

DoriosLib.registry.blockComponent("utilitycraft:storage_transfer_station", {
  beforeOnPlayerPlace(event, { params: settings }) {
    spawnStorageMachine(event, settings, {
      inputSlots: [],
      outputSlots: [],
    });
  },

  onTick({ block }) {
    const entity = getStorageTransferStationEntity(block);
    if (!entity?.isValid) return;
    transferCellData(entity);
  },

  onPlayerBreak({ block }) {
    const entity = getStorageTransferStationEntity(block);
    if (!entity?.isValid) return;

    dropInventory(entity, block);
    TickScheduler.releaseTickGroup(entity);
    entity.triggerEvent("despawn");
  },
});
