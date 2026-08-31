import { system, world } from "@minecraft/server";
import { readPagedJson, writePagedJsonJob } from "./persistence/paged_store.js";

export const NETWORK_TAG = "ucds:network";
export const NETWORK_CABLE_TAG = "ucds:network_cable";
export const NETWORK_MACHINE_TAG = "ucds:network_machine";
export const NETWORK_TOPOLOGY_PROPERTY = "ucds:network_topology";
export const V2_NETWORK_TOPOLOGY_PROPERTY = "ucds:v2:t";
export const V2_NETWORK_TOPOLOGY_READ_PROPERTY = "ucds:v2:t_read";

const STORAGE_CENTER_TYPE = "utilitycraft:storage_center";
const TOPOLOGY_VERSION = 1;
const ENERGY_COST_BY_TYPE = {
  "utilitycraft:storage_center": 10,
  "utilitycraft:storage_terminal": 10,
  "utilitycraft:crafting_terminal": 10,
  "utilitycraft:blueprint_terminal": 10,
  "utilitycraft:storage_cell_drive": 10,
  "utilitycraft:import_buffer": 20,
  "utilitycraft:export_buffer": 20,
};

const DIRECTIONS = [
  { name: "east", x: 1, y: 0, z: 0 },
  { name: "west", x: -1, y: 0, z: 0 },
  { name: "up", x: 0, y: 1, z: 0 },
  { name: "down", x: 0, y: -1, z: 0 },
  { name: "south", x: 0, y: 0, z: 1 },
  { name: "north", x: 0, y: 0, z: -1 },
];
const topologyWriteStates = new Map();

function locationKey(location) {
  return `${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}`;
}

function locationArray(location) {
  return [
    Math.floor(location.x),
    Math.floor(location.y),
    Math.floor(location.z),
  ];
}

function offsetLocation(location, direction) {
  return {
    x: Math.floor(location.x) + direction.x,
    y: Math.floor(location.y) + direction.y,
    z: Math.floor(location.z) + direction.z,
  };
}

function isNetworkBlock(block) {
  return block?.hasTag?.(NETWORK_TAG) === true;
}

function isNetworkCable(block) {
  return block?.hasTag?.(NETWORK_CABLE_TAG) === true;
}

function isNetworkMachine(block) {
  return block?.hasTag?.(NETWORK_MACHINE_TAG) === true;
}

function getMachineEntityAt(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === block.typeId);
}

function readExistingTopology(entity) {
  const paged = readPagedJson(entity, V2_NETWORK_TOPOLOGY_PROPERTY);
  if (paged?.value && typeof paged.value === "object") {
    return { ...paged.value, read: entity.getDynamicProperty(V2_NETWORK_TOPOLOGY_READ_PROPERTY) === true };
  }
  const raw = entity?.getDynamicProperty?.(NETWORK_TOPOLOGY_PROPERTY);
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  try {
    const topology = JSON.parse(raw);
    return topology && typeof topology === "object" ? topology : undefined;
  } catch {
    return undefined;
  }
}

function addMachineToTopology(topology, block) {
  const typeId = block.typeId;
  topology.machinesCount[typeId] = (topology.machinesCount[typeId] ?? 0) + 1;
  topology.energyTickCost += ENERGY_COST_BY_TYPE[typeId] ?? 0;

  let positions = topology.machinesPos[typeId];
  if (!positions) {
    positions = [];
    topology.machinesPos[typeId] = positions;
  }
  positions.push(locationArray(block.location));
}

/**
 * Updates the visual connection states of one network cable.
 *
 * The cable connects visually to any adjacent block tagged as `ucds:network`.
 * Machines do not get visual states; they only make adjacent cables connect.
 *
 * @param {import("@minecraft/server").Block} block Cable block.
 * @returns {boolean} True when a permutation was written.
 */
export function updateNetworkCableVisual(block) {
  if (!isNetworkCable(block) || !block?.permutation) return false;

  let permutation = block.permutation;
  let changed = false;

  for (const direction of DIRECTIONS) {
    const neighbor = block.dimension.getBlock(offsetLocation(block.location, direction));
    const shouldConnect = isNetworkBlock(neighbor);
    const stateName = `utilitycraft:${direction.name}`;
    const customState = /** @type {any} */ (stateName);

    if (permutation.getState(customState) === shouldConnect) continue;
    permutation = permutation.withState(customState, shouldConnect);
    changed = true;
  }

  if (!changed) return false;

  try {
    block.setPermutation(permutation);
    return true;
  } catch {
    return false;
  }
}

/**
 * Updates the changed block and its six neighbors when the physical network
 * shape changes.
 *
 * @param {import("@minecraft/server").Block} block Changed block.
 */
export function updateNetworkCableVisualAround(block) {
  if (!block?.dimension) return;

  const positions = [
    block.location,
    ...DIRECTIONS.map((direction) => offsetLocation(block.location, direction)),
  ];

  for (const position of positions) {
    const candidate = block.dimension.getBlock(position);
    if (candidate) updateNetworkCableVisual(candidate);
  }
}

/**
 * Scans one connected Digital Storage physical network.
 *
 * The scan follows every block tagged `ucds:network`. Only blocks tagged
 * `ucds:network_machine` are stored in the topology; cables are traversal and
 * visual-only.
 *
 * @param {import("@minecraft/server").Block} startBlock Network block.
 * @returns {object | undefined} Topology object.
 */
export function scanNetworkTopology(startBlock) {
  if (!isNetworkBlock(startBlock)) return undefined;

  const topology = {
    version: TOPOLOGY_VERSION,
    dimensionId: startBlock.dimension.id,
    updatedTick: system.currentTick,
    read: false,
    energyTickCost: 0,
    machinesCount: {},
    machinesPos: {},
  };

  const queue = [startBlock.location];
  const visited = new Set();

  while (queue.length > 0) {
    const position = queue.shift();
    const key = locationKey(position);
    if (visited.has(key)) continue;
    visited.add(key);

    const block = startBlock.dimension.getBlock(position);
    if (!isNetworkBlock(block)) continue;

    if (isNetworkMachine(block)) addMachineToTopology(topology, block);

    for (const direction of DIRECTIONS) {
      const neighborPosition = offsetLocation(block.location, direction);
      const neighborKey = locationKey(neighborPosition);
      if (visited.has(neighborKey)) continue;

      const neighbor = startBlock.dimension.getBlock(neighborPosition);
      if (isNetworkBlock(neighbor)) queue.push(neighborPosition);
    }
  }

  return topology;
}

/**
 * @param {import("@minecraft/server").Block} startBlock
 * @param {{blocksPerTick?:number, onComplete?:(topology:object|undefined, visited:Set<string>)=>void}} [options]
 */
export function* scanNetworkTopologyJob(startBlock, { blocksPerTick = 256, onComplete } = {}) {
  if (!isNetworkBlock(startBlock)) {
    onComplete?.(undefined, new Set());
    return;
  }
  const topology = {
    version: TOPOLOGY_VERSION,
    dimensionId: startBlock.dimension.id,
    updatedTick: system.currentTick,
    read: false,
    energyTickCost: 0,
    machinesCount: {},
    machinesPos: {},
  };
  const queue = [startBlock.location];
  const visited = new Set();
  const budget = Math.max(1, Math.floor(Number(blocksPerTick) || 1));
  let cursor = 0;
  let work = 0;
  while (cursor < queue.length) {
    const position = queue[cursor++];
    const key = locationKey(position);
    if (visited.has(key)) continue;
    visited.add(key);
    const block = startBlock.dimension.getBlock(position);
    if (!isNetworkBlock(block)) continue;
    if (isNetworkMachine(block)) addMachineToTopology(topology, block);
    for (const direction of DIRECTIONS) {
      const neighborPosition = offsetLocation(block.location, direction);
      const neighborKey = locationKey(neighborPosition);
      if (visited.has(neighborKey)) continue;
      const neighbor = startBlock.dimension.getBlock(neighborPosition);
      if (isNetworkBlock(neighbor)) queue.push(neighborPosition);
    }
    work += 1;
    if (work >= budget) {
      work = 0;
      yield;
    }
  }
  onComplete?.(topology, visited);
}

/**
 * Writes a topology snapshot to every storage center entity in that topology.
 *
 * @param {import("@minecraft/server").Dimension} dimension Network dimension.
 * @param {object | undefined} topology Topology snapshot.
 * @param {{preserveRead?: boolean}} [options] Write behavior.
 * @returns {number} Number of centers written.
 */
export function writeTopologyToCenters(dimension, topology, { preserveRead = false } = {}) {
  const centerPositions = topology?.machinesPos?.[STORAGE_CENTER_TYPE] ?? [];
  if (!dimension || centerPositions.length === 0) return 0;

  let written = 0;

  for (const [x, y, z] of centerPositions) {
    const block = dimension.getBlock({ x, y, z });
    if (!block || block.typeId !== STORAGE_CENTER_TYPE) continue;

    const entity = getMachineEntityAt(block);
    if (!entity?.isValid) continue;

    try {
      const existing = preserveRead ? readExistingTopology(entity) : undefined;
      const nextTopology = preserveRead && existing?.read === true
        ? { ...topology, read: true }
        : topology;
      queueTopologyWrite(entity, nextTopology);
      written += 1;
    } catch {}
  }

  return written;
}

function queueTopologyWrite(entity, topology) {
  let state = topologyWriteStates.get(entity.id);
  if (!state) {
    state = { entity, pending: undefined, running: false };
    topologyWriteStates.set(entity.id, state);
  }
  state.entity = entity;
  state.pending = topology;
  if (state.running) return;
  state.running = true;
  system.runJob(drainTopologyWrites(state));
}

export function writeTopologySnapshot(entity, topology) {
  if (!entity?.isValid || !topology) return false;
  queueTopologyWrite(entity, topology);
  return true;
}

function* drainTopologyWrites(state) {
  try {
    while (state.pending && state.entity?.isValid) {
      const topology = state.pending;
      state.pending = undefined;
      yield* writeTopologyJob(state.entity, topology);
    }
  } finally {
    topologyWriteStates.delete(state.entity?.id);
  }
}

function* writeTopologyJob(entity, topology) {
  try {
    yield* writePagedJsonJob(entity, V2_NETWORK_TOPOLOGY_PROPERTY, { ...topology, read: false }, {
      revision: Math.max(0, Math.floor(Number(topology.updatedTick) || 0)),
      pagesPerTick: 2,
    });
    entity.setDynamicProperty(V2_NETWORK_TOPOLOGY_READ_PROPERTY, topology.read === true);
  } catch (error) {
    console.warn(`[DigitalStorage] Unable to persist topology: ${error?.message ?? error}`);
  }
}

function rebuildTopologyFromCandidates(block, options = {}) {
  if (!block?.dimension) return;

  const positions = [
    block.location,
    ...DIRECTIONS.map((direction) => offsetLocation(block.location, direction)),
  ];
  system.runJob(rebuildTopologyJob(block.dimension, positions, options));
}

function* rebuildTopologyJob(dimension, positions, options) {
  const covered = new Set();
  for (const position of positions) {
    if (covered.has(locationKey(position))) continue;
    const candidate = dimension.getBlock(position);
    if (!isNetworkBlock(candidate)) continue;

    let result;
    let visited = new Set();
    yield* scanNetworkTopologyJob(candidate, {
      onComplete(topology, scannedPositions) {
        result = topology;
        visited = scannedPositions;
      },
    });
    for (const key of visited) covered.add(key);
    if (result) writeTopologyToCenters(dimension, result, options);
  }
}

function scheduleNetworkTopologyUpdate(block, options = {}) {
  if (!block?.dimension) return;

  system.runTimeout(() => {
    updateNetworkCableVisualAround(block);
    rebuildTopologyFromCandidates(block, options);
  }, 3);
}

world.afterEvents.playerPlaceBlock.subscribe(({ block }) => {
  if (!isNetworkBlock(block)) return;
  scheduleNetworkTopologyUpdate(block, {
    preserveRead: isNetworkCable(block),
  });
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation }) => {
  if (brokenBlockPermutation?.hasTag?.(NETWORK_TAG) !== true) return;
  scheduleNetworkTopologyUpdate(block, {
    preserveRead: brokenBlockPermutation?.hasTag?.(NETWORK_CABLE_TAG) === true,
  });
});
