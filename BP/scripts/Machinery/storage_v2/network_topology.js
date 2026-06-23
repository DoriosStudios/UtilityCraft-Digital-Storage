import { system, world } from "@minecraft/server";

export const NETWORK_TAG = "ucds:network";
export const NETWORK_CABLE_TAG = "ucds:network_cable";
export const NETWORK_MACHINE_TAG = "ucds:network_machine";
export const NETWORK_TOPOLOGY_PROPERTY = "ucds:network_topology";

const STORAGE_CENTER_TYPE = "utilitycraft:storage_center";
const TOPOLOGY_VERSION = 1;

const DIRECTIONS = [
  { name: "east", x: 1, y: 0, z: 0 },
  { name: "west", x: -1, y: 0, z: 0 },
  { name: "up", x: 0, y: 1, z: 0 },
  { name: "down", x: 0, y: -1, z: 0 },
  { name: "south", x: 0, y: 0, z: 1 },
  { name: "north", x: 0, y: 0, z: -1 },
];

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

function addMachineToTopology(topology, block) {
  const typeId = block.typeId;
  topology.machinesCount[typeId] = (topology.machinesCount[typeId] ?? 0) + 1;

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

    if (permutation.getState(stateName) === shouldConnect) continue;
    permutation = permutation.withState(stateName, shouldConnect);
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
 * Writes a topology snapshot to every storage center entity in that topology.
 *
 * @param {import("@minecraft/server").Dimension} dimension Network dimension.
 * @param {object | undefined} topology Topology snapshot.
 * @returns {number} Number of centers written.
 */
export function writeTopologyToCenters(dimension, topology) {
  const centerPositions = topology?.machinesPos?.[STORAGE_CENTER_TYPE] ?? [];
  if (!dimension || centerPositions.length === 0) return 0;

  const serialized = JSON.stringify(topology);
  console.warn(`[DSv2] network topology:\n${JSON.stringify(topology, null, 2)}`);
  let written = 0;

  for (const [x, y, z] of centerPositions) {
    const block = dimension.getBlock({ x, y, z });
    if (!block || block.typeId !== STORAGE_CENTER_TYPE) continue;

    const entity = getMachineEntityAt(block);
    if (!entity?.isValid) continue;

    try {
      entity.setDynamicProperty(NETWORK_TOPOLOGY_PROPERTY, serialized);
      written += 1;
    } catch {}
  }

  return written;
}

function rebuildTopologyFromCandidates(block) {
  if (!block?.dimension) return;

  const positions = [
    block.location,
    ...DIRECTIONS.map((direction) => offsetLocation(block.location, direction)),
  ];
  const scanned = new Set();

  for (const position of positions) {
    const candidate = block.dimension.getBlock(position);
    if (!isNetworkBlock(candidate)) continue;

    const topology = scanNetworkTopology(candidate);
    if (!topology) continue;

    const signature = JSON.stringify(topology.machinesPos);
    if (scanned.has(signature)) continue;
    scanned.add(signature);

    writeTopologyToCenters(block.dimension, topology);
  }
}

function scheduleNetworkTopologyUpdate(block) {
  if (!block?.dimension) return;

  system.runTimeout(() => {
    updateNetworkCableVisualAround(block);
    rebuildTopologyFromCandidates(block);
  }, 3);
}

world.afterEvents.playerPlaceBlock.subscribe(({ block }) => {
  if (!isNetworkBlock(block)) return;
  scheduleNetworkTopologyUpdate(block);
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation }) => {
  if (brokenBlockPermutation?.hasTag?.(NETWORK_TAG) !== true) return;
  scheduleNetworkTopologyUpdate(block);
});
