import * as DoriosLib from "DoriosLib/index.js";
import { MachineUpgradeRegistry, TickScheduler } from "DoriosCore/index.js";
import { spawnStorageMachine } from "../../../DigitalStorageCore/entities.js";
import { syncCellItem } from "../cell_item_sync.js";
import {
  ensureCellId,
  getCellId,
  isStorageCell,
  readCellRecord,
} from "../cell_store.js";
import { isStorageRuntimeReady } from "../network_runtime.js";
import { commitCellTransaction, hasPendingCellTransaction } from "../persistence/cell_transactions.js";
import { getEntryStorageDelta, getMaxInsertAmount } from "../storage_cost.js";

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
function belongsToNetwork(record) {
  return !!record?.networkId;
}

/**
 * Moves the current upgrade-adjusted batch from slot 0 into slot 1.
 *
 * @param {import("@minecraft/server").Entity} entity Storage Transfer Station entity.
 * @returns {number} Amount transferred.
 */
function transferCellData(entity) {
  if (!isStorageRuntimeReady()) return 0;
  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return 0;

  const source = readCellSlot(container, SOURCE_SLOT);
  const destination = readCellSlot(container, DESTINATION_SLOT);
  if (!source || !destination || source.cellId === destination.cellId) return 0;
  if (hasPendingCellTransaction(source.cellId) || hasPendingCellTransaction(destination.cellId)) return 0;
  if (source.record.itemCount <= 0) return 0;
  if (belongsToNetwork(source.record) || belongsToNetwork(destination.record)) return 0;

  let remainingBatch = Math.min(getTransferLimit(container), source.record.itemCount);
  if (remainingBatch <= 0) return 0;

  const sourceItems = { ...source.record.items };
  const destinationItems = { ...destination.record.items };
  let moved = 0;

  const entries = Object.entries(sourceItems).sort(([left], [right]) => {
    const leftExisting = destinationItems[left] > 0 ? 0 : 1;
    const rightExisting = destinationItems[right] > 0 ? 0 : 1;
    return leftExisting - rightExisting || left.localeCompare(right);
  });
  let destinationUsedUnits = destination.record.usedUnits;
  for (const [itemKey, rawAmount] of entries) {
    if (remainingBatch <= 0) break;

    const available = Math.max(0, Math.floor(Number(rawAmount) || 0));
    if (available <= 0) continue;

    const destinationBefore = Math.max(0, Math.floor(Number(destinationItems[itemKey]) || 0));
    const freeUnits = Math.max(0, destination.record.capacityUnits - destinationUsedUnits);
    const transfer = getMaxInsertAmount(
      itemKey,
      destinationBefore,
      freeUnits,
      Math.min(available, remainingBatch),
    );
    if (transfer <= 0) continue;
    const sourceRemaining = available - transfer;
    if (sourceRemaining > 0) sourceItems[itemKey] = sourceRemaining;
    else delete sourceItems[itemKey];

    destinationItems[itemKey] = destinationBefore + transfer;
    destinationUsedUnits += getEntryStorageDelta(itemKey, destinationBefore, destinationItems[itemKey]);
    moved += transfer;
    remainingBatch -= transfer;
  }

  if (moved <= 0) return 0;

  const committed = commitCellTransaction(
    {
      cellId: source.cellId,
      record: { ...source.record, version: source.record.version, items: sourceItems },
    },
    {
      cellId: destination.cellId,
      record: { ...destination.record, version: destination.record.version, items: destinationItems },
    },
  );
  if (!committed) return 0;
  const savedSource = readCellRecord(source.cellId);
  const savedDestination = readCellRecord(destination.cellId);
  if (!savedSource || !savedDestination) return 0;

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
