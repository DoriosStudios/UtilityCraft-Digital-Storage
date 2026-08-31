import { ItemStack, system } from "@minecraft/server";
import { EnergyStorage, TickScheduler } from "DoriosCore/index.js";
import * as DoriosLib from "DoriosLib/index.js";
import { spawnStorageMachine } from "../../../DigitalStorageCore/entities.js";
import { releaseCellNetwork } from "../cell_store.js";
import { getDriveEntity, getDriveKey, readDriveCells, setDriveNetworkId, setStoredDriveSignature } from "../drive_cells.js";
import {
  createNetworkFromCellIds,
  getNetwork,
  getNetworkSnapshot,
  getStorageRuntimeFailure,
  isStorageRuntimeReady,
  powerOffNetwork,
} from "../network_runtime.js";
import {
  NETWORK_TOPOLOGY_PROPERTY,
  V2_NETWORK_TOPOLOGY_PROPERTY,
  V2_NETWORK_TOPOLOGY_READ_PROPERTY,
  writeTopologySnapshot,
} from "../network_topology.js";
import { readPagedJson } from "../persistence/paged_store.js";
import { formatCompactCount, formatStorageBytes, formatStoragePercent } from "../storage_format.js";
import { getExportBufferEntity, setExportBufferNetworkId } from "./export_buffer.js";
import { getImportBufferEntity, setImportBufferNetworkId } from "./import_buffer.js";
import { CraftingTerminalInterface } from "../../interface/crafting_terminal.js";
import { StorageTerminalInterface } from "../../interface/terminal.js";

export const STORAGE_CENTER_ENTITY_TYPE = "utilitycraft:storage_center";

const STORAGE_TERMINAL_ENTITY_TYPE = "utilitycraft:storage_terminal";
const CRAFTING_TERMINAL_ENTITY_TYPE = "utilitycraft:crafting_terminal";
const STORAGE_CELL_DRIVE_TYPE = "utilitycraft:storage_cell_drive";
const IMPORT_BUFFER_TYPE = "utilitycraft:import_buffer";
const EXPORT_BUFFER_TYPE = "utilitycraft:export_buffer";
const LINKED_MACHINE_ENTITY_TYPES = [
  STORAGE_CELL_DRIVE_TYPE,
  IMPORT_BUFFER_TYPE,
  EXPORT_BUFFER_TYPE,
  STORAGE_TERMINAL_ENTITY_TYPE,
  CRAFTING_TERMINAL_ENTITY_TYPE,
];
const TERMINAL_TYPES = [
  { typeId: STORAGE_TERMINAL_ENTITY_TYPE, TerminalClass: StorageTerminalInterface },
  { typeId: CRAFTING_TERMINAL_ENTITY_TYPE, TerminalClass: CraftingTerminalInterface },
];

const CENTER_NETWORK_PROPERTY = "ucds:network_id";
const CENTER_STATUS_PROPERTY = "ucds:center_status";
const CENTER_LAST_DISPLAY_TICK_PROPERTY = "ucds:center_last_display_tick";
const CENTER_ENERGY_CAP = 512000;
const STATUS_ITEM_ID = "utilitycraft:ui_filler";
const DISPLAY_REFRESH_TICKS = 20;

function getStorageCenterEntity(block) {
  return block?.dimension?.getEntitiesAtBlockLocation(block.location)?.find((entity) => entity.typeId === STORAGE_CENTER_ENTITY_TYPE);
}

function getMachineEntityAt(dimension, typeId, position) {
  return dimension?.getEntitiesAtBlockLocation({ x: position[0], y: position[1], z: position[2] })?.find((entity) => entity.typeId === typeId);
}

function getBlockAt(dimension, position) {
  return dimension?.getBlock({ x: position[0], y: position[1], z: position[2] });
}

function getPositionKey(dimensionId, position) {
  return `${dimensionId}:${position[0]},${position[1]},${position[2]}`;
}

function getCenterKey(block) {
  return `${block.dimension.id}:${block.location.x},${block.location.y},${block.location.z}`;
}

function getNetworkId(entity) {
  const id = Math.floor(Number(entity?.getDynamicProperty?.(CENTER_NETWORK_PROPERTY)) || 0);
  return id > 0 ? id : 0;
}

function setNetworkId(entity, networkId) {
  if (!entity?.isValid) return;
  const id = Math.floor(Number(networkId) || 0);
  entity.setDynamicProperty(CENTER_NETWORK_PROPERTY, id > 0 ? id : undefined);
}

function readTopology(entity) {
  const paged = readPagedJson(entity, V2_NETWORK_TOPOLOGY_PROPERTY);
  if (paged?.value && typeof paged.value === "object") {
    return { ...paged.value, read: entity.getDynamicProperty(V2_NETWORK_TOPOLOGY_READ_PROPERTY) === true };
  }
  const raw = entity?.getDynamicProperty?.(NETWORK_TOPOLOGY_PROPERTY);
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  try {
    const topology = JSON.parse(raw);
    return topology && typeof topology === "object"
      ? {
          ...topology,
          read: entity.getDynamicProperty(V2_NETWORK_TOPOLOGY_READ_PROPERTY) === true
            || topology.read === true,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function markTopologyRead(entity, topology) {
  if (!entity?.isValid || !topology) return;

  try {
    if (readPagedJson(entity, V2_NETWORK_TOPOLOGY_PROPERTY)) {
      entity.setDynamicProperty(V2_NETWORK_TOPOLOGY_READ_PROPERTY, true);
    } else {
      entity.setDynamicProperty(V2_NETWORK_TOPOLOGY_READ_PROPERTY, true);
      writeTopologySnapshot(entity, { ...topology, read: true });
    }
  } catch (error) {
    console.warn(`[DigitalStorage] Unable to mark Storage Center topology as read: ${error?.message ?? error}`);
  }
}

function topologyNeedsApply(topology) {
  return topology?.read === false;
}

function getMachineCount(topology, typeId) {
  return Math.max(0, Math.floor(Number(topology?.machinesCount?.[typeId]) || 0));
}

function getMachinePositions(topology, typeId) {
  const positions = topology?.machinesPos?.[typeId];
  return Array.isArray(positions) ? positions.filter((position) => Array.isArray(position) && position.length >= 3) : [];
}

function getTopologyEnergyCost(topology) {
  const cost = Math.floor(Number(topology?.energyTickCost) || 0);
  return Math.max(10, cost);
}

function setStatus(entity, message, { warn = false, force = false } = {}) {
  const previous = entity.getDynamicProperty(CENTER_STATUS_PROPERTY);
  if (!force && previous === message) return;

  entity.setDynamicProperty(CENTER_STATUS_PROPERTY, message);
  // if (warn) console.warn(`[DigitalStorage] Storage Center: ${message}`);
}

function shouldRefreshDisplay(entity, force = false) {
  if (!TickScheduler.hasOpenUI(entity)) return false;
  if (force) {
    entity.setDynamicProperty(CENTER_LAST_DISPLAY_TICK_PROPERTY, system.currentTick);
    return true;
  }

  const lastTick = Math.floor(Number(entity.getDynamicProperty(CENTER_LAST_DISPLAY_TICK_PROPERTY) ?? -DISPLAY_REFRESH_TICKS));
  if (system.currentTick - lastTick < DISPLAY_REFRESH_TICKS) return false;

  entity.setDynamicProperty(CENTER_LAST_DISPLAY_TICK_PROPERTY, system.currentTick);
  return true;
}

function writeStatusDisplay(entity, status, topology, snapshot, { force = false } = {}) {
  if (!shouldRefreshDisplay(entity, force)) return;

  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return;

  const cost = getTopologyEnergyCost(topology);
  const item = new ItemStack(STATUS_ITEM_ID, 1);
  item.nameTag = ` `;
  item.setLore([
    `\u00A7r\u00A7bStorage Network: \u00A7f${status}`,
    `\u00A7r\u00A77 Stored: \u00A7f${formatCompactCount(snapshot?.itemCount ?? 0)} Items`,
    `\u00A7r\u00A77 Types: \u00A7f${formatCompactCount(snapshot?.typeCount ?? 0)} Item Types`,
    `\u00A7r\u00A77 Storage: \u00A7f${formatStorageBytes(snapshot?.usedUnits ?? 0)} / ${formatStorageBytes(snapshot?.capacityUnits ?? 0)} (${formatStoragePercent(snapshot?.usedUnits ?? 0, snapshot?.capacityUnits ?? 0)}%)`,
    `\u00A7r\u00A77 Cells: \u00A7f${snapshot?.cells?.length ?? 0}`,
    `\u00A7r\u00A77 Drives: \u00A7f${getMachineCount(topology, STORAGE_CELL_DRIVE_TYPE)}`,
    `\u00A7r\u00A77 Energy Usage: \u00A7f${EnergyStorage.formatEnergyToText(cost)}/t`,
  ]);
  container.setItem(1, item);
}

function displayEnergy(entity, energy) {
  if (!TickScheduler.hasOpenUI(entity)) return;
  energy.display(0);
}

function consumeNetworkEnergy(entity, energy, topology, networkId) {
  const cost = getTopologyEnergyCost(topology);
  const interval = TickScheduler.getProcessingInterval(entity);
  const required = cost * interval;
  if (energy.consume(required) === required) return true;

  setStatus(entity, "Missing Energy", { warn: true, force: true });
  powerOffCenterNetwork(entity, networkId);
  return false;
}

function getEntityNetworkId(entity) {
  try {
    const id = Math.floor(Number(entity?.getDynamicProperty?.(CENTER_NETWORK_PROPERTY)) || 0);
    return id > 0 ? id : 0;
  } catch {
    return 0;
  }
}

/**
 * Clears a retired runtime id from every loaded physical machine that used it.
 * Wireless panels are intentionally excluded because they bind to a stable
 * Storage Center position and resolve the current runtime id automatically.
 */
function unlinkLoadedNetworkMachines(dimension, networkId) {
  if (!dimension || !networkId) return 0;

  let unlinked = 0;
  for (const typeId of LINKED_MACHINE_ENTITY_TYPES) {
    for (const machine of dimension.getEntities({ type: typeId })) {
      if (!machine?.isValid || getEntityNetworkId(machine) !== networkId) continue;
      try {
        machine.setDynamicProperty(CENTER_NETWORK_PROPERTY, undefined);
        unlinked += 1;
      } catch {}
    }
  }
  return unlinked;
}

function powerOffCenterNetwork(entity, networkId = getNetworkId(entity)) {
  if (!networkId) return false;

  const poweredOff = powerOffNetwork(networkId);
  if (poweredOff) {
    unlinkLoadedNetworkMachines(entity.dimension, networkId);
    setNetworkId(entity, 0);
  }
  return poweredOff;
}

function getShortError(error) {
  const message = String(error?.message ?? error ?? "unknown_error");
  return message.length <= 96 ? message : `${message.slice(0, 93)}...`;
}

function collectDriveCells(dimension, topology) {
  const drivePositions = getMachinePositions(topology, STORAGE_CELL_DRIVE_TYPE);
  const cellIds = [];
  const driveEntities = [];
  const driveKeys = [];
  const ownedNetworkIds = new Set();

  for (const position of drivePositions) {
    const block = getBlockAt(dimension, position);
    const entity = getDriveEntity(block);
    if (!entity?.isValid) continue;

    const snapshot = readDriveCells(entity);
    if (snapshot.cellIds.length === 0) continue;

    driveEntities.push({ entity, signature: snapshot.signature });
    driveKeys.push(getDriveKey(block));
    cellIds.push(...snapshot.cellIds);
    for (const networkId of snapshot.ownedNetworkIds) ownedNetworkIds.add(networkId);
  }

  return {
    cellIds: [...new Set(cellIds)],
    driveEntities,
    driveKeys: [...new Set(driveKeys)],
    ownedNetworkIds,
  };
}

function recoverOwnedCells(cellIds, networkIds) {
  for (const networkId of networkIds) {
    powerOffNetwork(networkId);
    for (const cellId of cellIds) releaseCellNetwork(cellId, networkId);
  }
}

function buildTerminalKeys(topology) {
  const dimensionId = topology?.dimensionId ?? "minecraft:overworld";
  return TERMINAL_TYPES.flatMap(({ typeId }) =>
    getMachinePositions(topology, typeId).map((position) => getPositionKey(dimensionId, position)),
  );
}

function linkTopologyTerminals(dimension, topology, networkId) {
  let linked = 0;
  for (const { typeId, TerminalClass } of TERMINAL_TYPES) {
    for (const position of getMachinePositions(topology, typeId)) {
      const block = getBlockAt(dimension, position);
      const terminal = new TerminalClass(block);
      if (!terminal.valid) continue;

      if (terminal.linkNetwork(networkId)) linked += 1;
    }
  }
  return linked;
}

function linkTopologyImportBuffers(dimension, topology, networkId) {
  let linked = 0;
  for (const position of getMachinePositions(topology, IMPORT_BUFFER_TYPE)) {
    const block = getBlockAt(dimension, position);
    const bufferEntity = getImportBufferEntity(block);
    if (!bufferEntity?.isValid) continue;

    setImportBufferNetworkId(bufferEntity, networkId);
    linked += 1;
  }
  return linked;
}

function linkTopologyExportBuffers(dimension, topology, networkId) {
  let linked = 0;
  for (const position of getMachinePositions(topology, EXPORT_BUFFER_TYPE)) {
    const block = getBlockAt(dimension, position);
    const bufferEntity = getExportBufferEntity(block);
    if (!bufferEntity?.isValid) continue;

    setExportBufferNetworkId(bufferEntity, networkId);
    linked += 1;
  }
  return linked;
}

function initializeNetwork(entity, block, energy, topology) {
  const cost = getTopologyEnergyCost(topology);
  if (!energy.has(cost * 100)) {
    setStatus(entity, "Missing Energy", { warn: true });
    writeStatusDisplay(entity, "Missing Energy", topology, undefined, { force: true });
    return;
  }

  if (getMachineCount(topology, STORAGE_CENTER_ENTITY_TYPE) !== 1) {
    setStatus(entity, "More Than One Network Center", { warn: true });
    writeStatusDisplay(entity, "More Than One Network Center", topology, undefined, { force: true });
    return;
  }

  if (getMachineCount(topology, STORAGE_CELL_DRIVE_TYPE) <= 0) {
    setStatus(entity, "Missing Drives", { warn: true });
    writeStatusDisplay(entity, "Missing Drives", topology, undefined, { force: true });
    return;
  }

  let driveSnapshot = collectDriveCells(block.dimension, topology);
  if (driveSnapshot.cellIds.length === 0) {
    setStatus(entity, "Missing Storage Cells", { warn: true });
    writeStatusDisplay(entity, "Missing Storage Cells", topology, undefined, { force: true });
    return;
  }

  if (driveSnapshot.ownedNetworkIds.size > 0) {
    setStatus(entity, "Recovering Previous Network", { force: true });
    writeStatusDisplay(entity, "Recovering Previous Network", topology, undefined, { force: true });

    try {
      recoverOwnedCells(driveSnapshot.cellIds, driveSnapshot.ownedNetworkIds);
      driveSnapshot = collectDriveCells(block.dimension, topology);
    } catch (error) {
      console.warn(`[DigitalStorage] Network recovery failed: ${error?.stack ?? error}`);
      const reason = getShortError(error);
      const status = `Recovery Failed: ${reason}`;
      const previousNetworkId = [...driveSnapshot.ownedNetworkIds][0];
      const previousSnapshot = previousNetworkId ? getNetworkSnapshot(previousNetworkId) : undefined;
      setStatus(entity, status, { warn: true, force: true });
      writeStatusDisplay(entity, status, topology, previousSnapshot, { force: true });
      return;
    }
  }

  const { cellIds, driveEntities, driveKeys } = driveSnapshot;

  setStatus(entity, "Initializing", { force: true });
  writeStatusDisplay(entity, "Initializing", topology, undefined, { force: true });

  let network;
  try {
    network = createNetworkFromCellIds(cellIds, {
      online: true,
      center: getCenterKey(block),
      centers: [getCenterKey(block)],
      drives: driveKeys,
      terminals: buildTerminalKeys(topology),
    });
  } catch (error) {
    console.warn(`[DigitalStorage] Network initialization failed: ${error?.stack ?? error}`);
    const reason = getShortError(error);
    const status = `Initialization Failed: ${reason}`;
    setStatus(entity, status, { warn: true, force: true });
    writeStatusDisplay(entity, status, topology, undefined, { force: true });
    return;
  }

  if (!network?.networkId) {
    const status = "Initialization Failed: Network record could not be loaded";
    setStatus(entity, status, { warn: true, force: true });
    writeStatusDisplay(entity, status, topology, undefined, { force: true });
    return;
  }

  setNetworkId(entity, network.networkId);
  markTopologyRead(entity, topology);
  for (const drive of driveEntities) {
    setDriveNetworkId(drive.entity, network.networkId);
    setStoredDriveSignature(drive.entity, drive.signature);
  }

  system.run(() => {
    const linked = linkTopologyTerminals(block.dimension, topology, network.networkId);
    linkTopologyImportBuffers(block.dimension, topology, network.networkId);
    linkTopologyExportBuffers(block.dimension, topology, network.networkId);
    setStatus(entity, `Online (${linked} terminals)`, { force: true });
  });
}

function tickCenter(entity, block) {
  if (!TickScheduler.shouldProcessMachine(entity)) return;

  const energy = new EnergyStorage(entity);
  if (energy.getCap() <= 0) energy.setCap(CENTER_ENERGY_CAP);
  displayEnergy(entity, energy);

  if (!isStorageRuntimeReady()) {
    const failure = getStorageRuntimeFailure();
    const status = failure ? `Recovery Failed: ${failure}` : "Loading";
    setStatus(entity, status, { warn: !!failure, force: true });
    writeStatusDisplay(entity, status, undefined, undefined, { force: true });
    return;
  }

  const topology = readTopology(entity);
  if (!topology) {
    setStatus(entity, "Missing Topology", { warn: true });
    writeStatusDisplay(entity, "Missing Topology", undefined, undefined, { force: true });
    return;
  }

  const networkId = getNetworkId(entity);
  if (!networkId) {
    initializeNetwork(entity, block, energy, topology);
    return;
  }

  if (topologyNeedsApply(topology)) {
    setStatus(entity, "Topology Changed", { warn: true, force: true });
    writeStatusDisplay(entity, "Topology Changed", topology, undefined, { force: true });
    powerOffCenterNetwork(entity, networkId);
    return;
  }

  const runtime = getNetwork(networkId);
  if (!runtime?.online) {
    unlinkLoadedNetworkMachines(entity.dimension, networkId);
    setNetworkId(entity, 0);
    setStatus(entity, "Offline", { warn: true, force: true });
    writeStatusDisplay(entity, "Offline", topology, undefined, { force: true });
    return;
  }

  if (!consumeNetworkEnergy(entity, energy, topology, networkId)) return;

  const snapshot = getNetworkSnapshot(networkId);
  const displayStatus = (snapshot?.overCapacityUnits ?? 0) > 0 ? "Over Capacity" : "Online";
  setStatus(entity, displayStatus);
  writeStatusDisplay(entity, displayStatus, topology, snapshot);
}

DoriosLib.registry.blockComponent("utilitycraft:storage_center", {
  beforeOnPlayerPlace(event, { params: settings }) {
    spawnStorageMachine(event, settings, {
      inputSlots: [],
      outputSlots: [],
    }, (entity) => {
      new EnergyStorage(entity).setCap(CENTER_ENERGY_CAP);
      entity.setDynamicProperty(CENTER_STATUS_PROPERTY, "");
      entity.setDynamicProperty(CENTER_LAST_DISPLAY_TICK_PROPERTY, -DISPLAY_REFRESH_TICKS);
    });
  },

  onTick({ block }) {
    const entity = getStorageCenterEntity(block);
    if (!entity?.isValid) return;
    tickCenter(entity, block);
  },

  onPlayerBreak({ block }) {
    const entity = getStorageCenterEntity(block);
    if (!entity?.isValid) return;

    powerOffCenterNetwork(entity);
    TickScheduler.releaseTickGroup(entity);
    entity.triggerEvent("despawn");
  },
});
