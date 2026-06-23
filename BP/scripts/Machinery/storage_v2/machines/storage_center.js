import { ItemStack, system } from "@minecraft/server";
import { EnergyStorage, TickScheduler } from "DoriosCore/index.js";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import { getDriveEntity, getDriveKey, readDriveCells, setDriveNetworkId, setStoredDriveSignature } from "../drive_cells.js";
import { createNetworkFromCellIds, getNetwork, getNetworkSnapshot, powerOffNetwork } from "../network_runtime.js";
import { NETWORK_TOPOLOGY_PROPERTY } from "../network_topology.js";
import { getImportBufferEntity, setImportBufferNetworkId } from "./import_buffer.js";
import { storageTerminalInterface } from "./storage_terminal.js";

export const STORAGE_CENTER_ENTITY_TYPE = "utilitycraft:storage_center";

const STORAGE_TERMINAL_ENTITY_TYPE = "utilitycraft:storage_terminal";
const STORAGE_CELL_DRIVE_TYPE = "utilitycraft:storage_cell_drive";
const IMPORT_BUFFER_TYPE = "utilitycraft:import_buffer";

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
  const raw = entity?.getDynamicProperty?.(NETWORK_TOPOLOGY_PROPERTY);
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  try {
    const topology = JSON.parse(raw);
    return topology && typeof topology === "object" ? topology : undefined;
  } catch {
    return undefined;
  }
}

function markTopologyRead(entity, topology) {
  if (!entity?.isValid || !topology) return;

  try {
    entity.setDynamicProperty(NETWORK_TOPOLOGY_PROPERTY, JSON.stringify({
      ...topology,
      read: true,
    }));
  } catch {}
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
  if (warn) console.warn(`[DSv2] Storage Center: ${message}`);
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
    `\u00A7r\u00A7bStorage Network`,
    `\u00A7r\u00A77  Status: \u00A7f${status}`,
    `\u00A7r\u00A77  Stored: \u00A7f${formatAmount(snapshot?.used ?? 0)} / ${formatAmount(snapshot?.capacity ?? 0)}`,
    `\u00A7r\u00A77  Usage: \u00A7f${formatPercent(snapshot?.used ?? 0, snapshot?.capacity ?? 0)}%%`,
    `\u00A7r\u00A77  Cells: \u00A7f${snapshot?.cells?.length ?? 0}`,
    `\u00A7r\u00A77  Drives: \u00A7f${getMachineCount(topology, STORAGE_CELL_DRIVE_TYPE)}`,
    `\u00A7r\u00A77  Cost: \u00A7f${EnergyStorage.formatEnergyToText(cost)}/t`,
  ]);
  container.setItem(1, item);
}

function formatAmount(value) {
  const amount = Math.max(0, Math.floor(Number(value) || 0));
  if (amount < 1000) return String(amount);

  const units = ["K", "M", "B", "T"];
  let scaled = amount;
  let unit = "";
  for (const nextUnit of units) {
    if (scaled < 1000) break;
    scaled /= 1000;
    unit = nextUnit;
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${unit}`;
}

function formatPercent(used, capacity) {
  const max = Math.max(0, Number(capacity) || 0);
  if (max <= 0) return "0.00%";
  return `${Math.min(100, (Math.max(0, Number(used) || 0) / max) * 100).toFixed(2)}%`;
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
  powerOffCenterNetwork(entity, topology, networkId);
  return false;
}

function powerOffCenterNetwork(entity, topology, networkId = getNetworkId(entity)) {
  if (!networkId) return false;

  unlinkTopologyDrives(entity.dimension, topology);
  unlinkTopologyImportBuffers(entity.dimension, topology);
  const poweredOff = powerOffNetwork(networkId);
  setNetworkId(entity, 0);
  return poweredOff;
}

function unlinkTopologyDrives(dimension, topology) {
  for (const position of getMachinePositions(topology, STORAGE_CELL_DRIVE_TYPE)) {
    const block = getBlockAt(dimension, position);
    const driveEntity = getDriveEntity(block);
    if (driveEntity?.isValid) setDriveNetworkId(driveEntity, 0);
  }
}

function unlinkTopologyImportBuffers(dimension, topology) {
  for (const position of getMachinePositions(topology, IMPORT_BUFFER_TYPE)) {
    const block = getBlockAt(dimension, position);
    const bufferEntity = getImportBufferEntity(block);
    if (bufferEntity?.isValid) setImportBufferNetworkId(bufferEntity, 0);
  }
}

function collectDriveCells(dimension, topology) {
  const drivePositions = getMachinePositions(topology, STORAGE_CELL_DRIVE_TYPE);
  const cellIds = [];
  const driveEntities = [];
  const driveKeys = [];

  for (const position of drivePositions) {
    const block = getBlockAt(dimension, position);
    const entity = getDriveEntity(block);
    if (!entity?.isValid) continue;

    const snapshot = readDriveCells(entity);
    if (snapshot.cellIds.length === 0) continue;

    driveEntities.push({ entity, signature: snapshot.signature });
    driveKeys.push(getDriveKey(block));
    cellIds.push(...snapshot.cellIds);
  }

  return {
    cellIds: [...new Set(cellIds)],
    driveEntities,
    driveKeys: [...new Set(driveKeys)],
  };
}

function buildTerminalKeys(topology) {
  const dimensionId = topology?.dimensionId ?? "minecraft:overworld";
  return getMachinePositions(topology, STORAGE_TERMINAL_ENTITY_TYPE).map((position) => getPositionKey(dimensionId, position));
}

function linkTopologyTerminals(dimension, topology, networkId) {
  let linked = 0;
  for (const position of getMachinePositions(topology, STORAGE_TERMINAL_ENTITY_TYPE)) {
    const terminalEntity = getMachineEntityAt(dimension, STORAGE_TERMINAL_ENTITY_TYPE, position);
    if (!terminalEntity?.isValid) continue;

    if (storageTerminalInterface.linkNetwork(terminalEntity, networkId)) linked += 1;
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

  const { cellIds, driveEntities, driveKeys } = collectDriveCells(block.dimension, topology);
  if (cellIds.length === 0) {
    setStatus(entity, "Missing Storage Cells", { warn: true });
    writeStatusDisplay(entity, "Missing Storage Cells", topology, undefined, { force: true });
    return;
  }

  setStatus(entity, "Initializing Network", { force: true });
  writeStatusDisplay(entity, "Initializing Network", topology, undefined, { force: true });

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
    setStatus(entity, `Network Init Failed: ${error?.message ?? error}`, { warn: true, force: true });
    writeStatusDisplay(entity, "Network Init Failed", topology, undefined, { force: true });
    return;
  }

  if (!network?.networkId) {
    setStatus(entity, "Network Init Failed", { warn: true, force: true });
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
    setStatus(entity, `Online (${linked} terminals)`, { force: true });
  });
}

function tickCenter(entity, block) {
  if (!TickScheduler.shouldProcessMachine(entity)) return;

  const energy = new EnergyStorage(entity);
  if (energy.getCap() <= 0) energy.setCap(CENTER_ENERGY_CAP);
  displayEnergy(entity, energy);

  const topology = readTopology(entity);
  if (!topology) {
    setStatus(entity, "Missing Network Topology", { warn: true });
    writeStatusDisplay(entity, "Missing Network Topology", undefined, undefined, { force: true });
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
    powerOffCenterNetwork(entity, topology, networkId);
    return;
  }

  const runtime = getNetwork(networkId);
  if (!runtime?.online) {
    setNetworkId(entity, 0);
    setStatus(entity, "Network Offline", { warn: true, force: true });
    writeStatusDisplay(entity, "Network Offline", topology, undefined, { force: true });
    return;
  }

  if (!consumeNetworkEnergy(entity, energy, topology, networkId)) return;

  const snapshot = getNetworkSnapshot(networkId);
  setStatus(entity, "Online");
  writeStatusDisplay(entity, "Online", topology, snapshot);
}

DoriosAPI.register.blockComponent("storage_center", {
  onPlace({ block }) {
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: STORAGE_CENTER_ENTITY_TYPE,
          inventory_size: 2,
          name: "storage_center",
        },
      });
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

    const topology = readTopology(entity);
    powerOffCenterNetwork(entity, topology);
    TickScheduler.releaseTickGroup(entity);
    entity.triggerEvent("despawn");
  },
});
