import { system, world } from "@minecraft/server";
import {
  allocateNetworkId,
  ensureCellId,
  getCellId,
  isStorageCell,
  readNetworkMeta,
  readNetworkRecord,
  rebuildNetworkTotals,
  writeNetworkRecord,
} from "./storage_db.js";

export const UPDATE_NETWORK_EVENT_ID = "utilitycraft:ds_update_network";

export const DS_CONDUITS = [
  "utilitycraft:network_cable",
];

const MACHINE_TYPES = new Set([
  "utilitycraft:storage_cell_drive",
  "utilitycraft:storage_center",
  "utilitycraft:storage_terminal",
  "utilitycraft:crafting_terminal",
  "utilitycraft:blueprint_terminal",
  "utilitycraft:import_buffer",
  "utilitycraft:export_buffer",
]);

const DIRECTIONS = [
  { name: "east", x: 1, y: 0, z: 0 },
  { name: "west", x: -1, y: 0, z: 0 },
  { name: "up", x: 0, y: 1, z: 0 },
  { name: "down", x: 0, y: -1, z: 0 },
  { name: "south", x: 0, y: 0, z: 1 },
  { name: "north", x: 0, y: 0, z: -1 },
];

const blockNetworkCache = new Map();
const NETWORK_BLOCK_COUNT_PROPERTY = "ucds_network_block_count";
const NETWORK_BASE_RATE_PROPERTY = "ucds_network_base_rate";
const NETWORK_IS_CORE_PROPERTY = "ucds_network_is_core";

const NETWORK_BASE_RATES = {
  "utilitycraft:storage_center": 10,
  "utilitycraft:storage_terminal": 2,
  "utilitycraft:crafting_terminal": 4,
  "utilitycraft:blueprint_terminal": 4,
  "utilitycraft:storage_cell_drive": 5,
};

function locKey(dimension, location) {
  return `${dimension.id}|${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}`;
}

function coordTag(location) {
  return `[${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}]`;
}

function entityNetworkTag(entity) {
  return `${entity.dimension.id}|${coordTag(entity.location)}`;
}

function readCoordTag(tag) {
  const [x, y, z] = tag
    .slice(tag.indexOf("[") + 1, tag.lastIndexOf("]"))
    .split(",")
    .map(Number);
  return { x, y, z };
}

function isConduit(block) {
  return !!block && (DS_CONDUITS.includes(block.typeId) || block.hasTag?.("ucds:is_conduit"));
}

function isStorageNode(block) {
  return !!block && (
    block.typeId === "utilitycraft:storage_cell_drive" ||
    block.typeId === "utilitycraft:storage_center" ||
    block.typeId === "utilitycraft:storage_terminal" ||
    block.typeId === "utilitycraft:crafting_terminal" ||
    block.typeId === "utilitycraft:blueprint_terminal" ||
    block.hasTag?.("ucds:item_network")
  );
}

function getEntityAt(block, typeId) {
  return block.dimension.getEntitiesAtBlockLocation(block.location).find((entity) => entity.typeId === typeId);
}

function getMachineEntityAt(block) {
  return block.dimension.getEntitiesAtBlockLocation(block.location).find((entity) => MACHINE_TYPES.has(entity.typeId));
}

function networkContainsBlock(block, network) {
  if (!network) return false;
  if (isConduit(block)) return true;

  const entity = getMachineEntityAt(block);
  if (!entity) return false;

  const tag = entityNetworkTag(entity);
  if (entity.typeId === "utilitycraft:storage_center") {
    return network.core === tag || network.cores?.includes(tag);
  }
  if (entity.typeId === "utilitycraft:storage_cell_drive") {
    return network.drives?.includes(tag);
  }
  return network.terminals?.includes(tag);
}

function canAccessNetworkRecord(block, network) {
  return !!network && networkContainsBlock(block, network);
}

function setNetworkTags(entity, networkId) {
  const hex = networkId.toString(16);
  for (const tag of entity.getTags()) {
    if (tag.startsWith("ucds_net_") && tag !== `ucds_net_${hex}`) {
      entity.removeTag(tag);
    }
  }
  entity.addTag(`ucds_net_${hex}`);
  entity.setDynamicProperty("ucds_network_id", networkId);
}

function clearNetworkTags(entity) {
  for (const tag of entity.getTags()) {
    if (tag.startsWith("ucds_net_")) entity.removeTag(tag);
  }
  entity.setDynamicProperty("ucds_network_id", undefined);
  blockNetworkCache.delete(locKey(entity.dimension, entity.location));
}

function getNetworkBaseRate(entity) {
  return Math.max(0, Math.floor(Number(NETWORK_BASE_RATES[entity?.typeId] ?? 0)));
}

function isNetworkAnchor(entity) {
  return entity?.typeId === "utilitycraft:storage_center" ||
    entity?.typeId === "utilitycraft:storage_cell_drive";
}

function resolveNetworkId(entities) {
  const entityTags = new Set(entities.map(entityNetworkTag));
  const ids = entities
    .map((entity) => entity.getDynamicProperty("ucds_network_id"))
    .filter((id) => Number.isInteger(id) && id > 0);
  const reusableIds = ids.filter((id) => {
    const network = readNetworkMeta(id);
    return !network?.core || entityTags.has(network.core);
  });

  return reusableIds.length > 0 ? Math.min(...reusableIds) : allocateNetworkId();
}

function updateConduitGeometry(block) {
  if (!isConduit(block) || !block?.permutation) return;

  let permutation = block.permutation;
  for (const direction of DIRECTIONS) {
    const neighbor = block.dimension.getBlock({
      x: block.location.x + direction.x,
      y: block.location.y + direction.y,
      z: block.location.z + direction.z,
    });
    const shouldConnect = !!neighbor && (
      isConduit(neighbor) ||
      (!isConduit(neighbor) && isStorageNode(neighbor))
    );
    permutation = permutation.withState(`utilitycraft:${direction.name}`, shouldConnect);
  }
  block.setPermutation(permutation);
}

function scanNetwork(startBlock) {
  const queue = [startBlock.location];
  const visited = new Set();
  const conduits = [];
  const entities = [];

  while (queue.length > 0) {
    const pos = queue.shift();
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const block = startBlock.dimension.getBlock(pos);
    if (!block || (!isConduit(block) && !isStorageNode(block))) continue;

    const machineEntity = getMachineEntityAt(block);
    if (machineEntity) entities.push(machineEntity);
    if (isConduit(block)) conduits.push(block);

    const traversable = isConduit(block) || key === `${startBlock.location.x},${startBlock.location.y},${startBlock.location.z}`;
    if (!traversable) continue;

    for (const direction of DIRECTIONS) {
      const next = {
        x: block.location.x + direction.x,
        y: block.location.y + direction.y,
        z: block.location.z + direction.z,
      };
      const neighbor = startBlock.dimension.getBlock(next);
      if (!neighbor || (!isConduit(neighbor) && !isStorageNode(neighbor))) continue;
      queue.push(next);
    }
  }

  return { conduits, entities };
}

export function rebuildNetworkFromBlock(block) {
  if (!block || (!isConduit(block) && !isStorageNode(block))) return undefined;

  const { conduits, entities } = scanNetwork(block);
  if (entities.length === 0 && conduits.length === 0) return undefined;
  if (!entities.some(isNetworkAnchor)) {
    for (const entity of entities) clearNetworkTags(entity);
    for (const conduit of conduits) {
      blockNetworkCache.delete(locKey(conduit.dimension, conduit.location));
      updateConduitGeometry(conduit);
    }
    return undefined;
  }

  const networkId = resolveNetworkId(entities);
  const cells = [];
  const drives = [];
  const terminals = [];
  const cores = [];

  for (const entity of entities) {
    setNetworkTags(entity, networkId);
    blockNetworkCache.set(locKey(entity.dimension, entity.location), networkId);

    if (entity.typeId === "utilitycraft:storage_center") {
      cores.push(`${entity.dimension.id}|${coordTag(entity.location)}`);
      continue;
    }

    if (entity.typeId === "utilitycraft:storage_cell_drive") {
      drives.push(`${entity.dimension.id}|${coordTag(entity.location)}`);
      const container = entity.getComponent("minecraft:inventory")?.container;
      if (container) {
        for (let slot = 1; slot <= 9; slot++) {
          const cell = container.getItem(slot);
          if (!isStorageCell(cell)) continue;
          const previousCellId = getCellId(cell);
          const cellId = ensureCellId(cell);
          if (cellId) {
            cells.push(cellId);
            if (!previousCellId) container.setItem(slot, cell);
          }
        }
      }
      continue;
    }

    terminals.push(`${entity.dimension.id}|${coordTag(entity.location)}`);
  }

  const previous = readNetworkRecord(networkId) ?? {};
  const uniqueCells = [...new Set(cells)];
  const uniqueCores = [...new Set(cores)];
  const core = uniqueCores.includes(previous.core) ? previous.core : uniqueCores[0];
  const blockCount = entities.length;
  const baseRate = entities.reduce((sum, entity) => sum + getNetworkBaseRate(entity), 0);
  for (const entity of entities) {
    if (entity.typeId === "utilitycraft:storage_center") {
      const centerTag = `${entity.dimension.id}|${coordTag(entity.location)}`;
      entity.setDynamicProperty(NETWORK_BLOCK_COUNT_PROPERTY, blockCount);
      entity.setDynamicProperty(NETWORK_BASE_RATE_PROPERTY, baseRate);
      entity.setDynamicProperty(NETWORK_IS_CORE_PROPERTY, centerTag === core);
    }
  }
  writeNetworkRecord(networkId, {
    ...previous,
    cells: uniqueCells,
    drives,
    terminals,
    cores: uniqueCores,
    core,
    blockCount,
    baseRate,
    online: uniqueCores.length > 0 && core === previous.core ? previous.online === true : false,
    version: previous.version ?? 0,
  });
  rebuildNetworkTotals(networkId, uniqueCells, {
    reloadAll: true,
    reason: "network_structure",
  });

  for (const conduit of conduits) {
    blockNetworkCache.set(locKey(conduit.dimension, conduit.location), networkId);
    updateConduitGeometry(conduit);
  }

  return networkId;
}

export function updateNetworkAround(block) {
  if (!block) return;
  const positions = [
    block.location,
    ...DIRECTIONS.map((direction) => ({
      x: block.location.x + direction.x,
      y: block.location.y + direction.y,
      z: block.location.z + direction.z,
    })),
  ];

  system.runTimeout(() => {
    for (const position of positions) {
      const candidate = block.dimension.getBlock(position);
      if (candidate && (isConduit(candidate) || isStorageNode(candidate))) {
        rebuildNetworkFromBlock(candidate);
      }
    }
  }, 2);
}

export function getNetworkIdForBlock(block) {
  const key = locKey(block.dimension, block.location);
  const cached = blockNetworkCache.get(key);
  if (cached) {
    const cachedRecord = readNetworkMeta(cached);
    if (canAccessNetworkRecord(block, cachedRecord)) return cached;
    blockNetworkCache.delete(key);
  }

  const entity = getMachineEntityAt(block);
  const entityNetworkId = entity?.getDynamicProperty("ucds_network_id");
  if (Number.isInteger(entityNetworkId)) {
    const entityRecord = readNetworkMeta(entityNetworkId);
    if (canAccessNetworkRecord(block, entityRecord)) {
      blockNetworkCache.set(key, entityNetworkId);
      return entityNetworkId;
    }
    clearNetworkTags(entity);
  }

  const rebuiltNetworkId = rebuildNetworkFromBlock(block);
  return canAccessNetworkRecord(block, readNetworkMeta(rebuiltNetworkId))
    ? rebuiltNetworkId
    : undefined;
}

export function getNetworkNodes(block) {
  const networkId = getNetworkIdForBlock(block);
  const network = readNetworkRecord(networkId);
  const nodes = [];
  if (!network) return nodes;
  if (network.online === false) {
    nodes.networkId = networkId;
    nodes.record = network;
    return nodes;
  }

  for (const tag of network.drives ?? []) {
    const [dimensionId, coord] = tag.split("|");
    if (dimensionId !== block.dimension.id) continue;
    const position = readCoordTag(coord);
    const driveBlock = block.dimension.getBlock(position);
    if (!driveBlock) continue;
    const driveEntity = getEntityAt(driveBlock, "utilitycraft:storage_cell_drive");
    const container = driveEntity?.getComponent("minecraft:inventory")?.container;
    if (container) nodes.push({ container, isDrive: true, networkId });
  }

  nodes.networkId = networkId;
  nodes.record = network;
  return nodes;
}

function directionVector(direction) {
  switch (direction) {
    case 0: return { x: 0, y: -1, z: 0 };
    case 1: return { x: 0, y: 1, z: 0 };
    case 2: return { x: 0, y: 0, z: -1 };
    case 3: return { x: 0, y: 0, z: 1 };
    case 4: return { x: -1, y: 0, z: 0 };
    case 5: return { x: 1, y: 0, z: 0 };
    default: return { x: 0, y: 0, z: 0 };
  }
}

system.afterEvents.scriptEventReceive.subscribe(({ id, message, sourceEntity }) => {
  if (id !== UPDATE_NETWORK_EVENT_ID) return;

  const parts = String(message ?? "").split("|");
  const rawPosition = parts.length > 1 ? parts[1] : parts[0];
  const [x, y, z] = rawPosition.replace(/[\[\]]/g, "").split(",").map(Number);
  const dimension = sourceEntity?.dimension;
  if (!dimension || ![x, y, z].every(Number.isFinite)) return;

  const block = dimension.getBlock({ x, y, z });
  if (block) updateNetworkAround(block);
});

world.afterEvents.playerPlaceBlock.subscribe(({ block }) => {
  if (isConduit(block) || isStorageNode(block)) updateNetworkAround(block);
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation }) => {
  system.run(() => {
    if (
      DS_CONDUITS.includes(brokenBlockPermutation.type.id) ||
      brokenBlockPermutation.hasTag("ucds:item_network") ||
      brokenBlockPermutation.hasTag("ucds:is_conduit")
    ) {
      updateNetworkAround(block);
    }
  });
});

world.afterEvents.pistonActivate.subscribe(({ piston, isExpanding, dimension }) => {
  const locations = piston.getAttachedBlocksLocations();
  if (!locations || locations.length === 0) return;

  const facing = piston.block.permutation.getState("facing_direction");
  const direction = directionVector(facing);
  const step = isExpanding ? -1 : 1;

  system.runTimeout(() => {
    for (const position of locations) {
      const moved = dimension.getBlock(position);
      const previous = dimension.getBlock({
        x: position.x + direction.x * step,
        y: position.y + direction.y * step,
        z: position.z + direction.z * step,
      });

      if (
        (moved && (isConduit(moved) || isStorageNode(moved))) ||
        (previous && (isConduit(previous) || isStorageNode(previous)))
      ) {
        if (moved) updateNetworkAround(moved);
        if (previous) updateNetworkAround(previous);
      }
    }
  }, 2);
});
