import { system, world } from "@minecraft/server";
import { isStorageCell, readCellRecord } from "./cell_store.js";
import {
  addItem,
  addItemStack,
  createNetworkFromCellIds,
  flushNetwork,
  getNetworkSnapshot,
  getSortedItems,
  powerOffAllNetworks,
  powerOffNetwork,
  reloadNetwork,
  removeItem,
  setNetworkOnline,
} from "./network_runtime.js";
import { createItemFromKey, getItemKey } from "./item_registry.js";
import {
  getDriveEntity,
  getDriveKey,
  readDriveCells,
  setDriveNetworkId,
  setStoredDriveSignature,
} from "./drive_cells.js";

/**
 * Debug command surface for Digital Storage.
 *
 * These commands exist so the database/runtime can be tested before terminal UI
 * is rebuilt. They should stay thin: parse command input, call the runtime API,
 * and print clear results. Real gameplay systems should import runtime helpers
 * directly instead of going through script events.
 */

function reply(event, message) {
  const text = `[DigitalStorage] ${message}`;
  try {
    event.sourceEntity?.sendMessage?.(text);
  } catch {}
  // console.warn(text);
}

/**
 * Parses JSON command payloads.
 *
 * Invalid or empty payloads intentionally become `{}` so commands can provide
 * their own usage messages.
 *
 * @param {string} message Raw script event message.
 * @returns {object | object[]} Parsed payload.
 */
function parseMessage(message) {
  if (!message || String(message).trim().length === 0) return {};
  try {
    return JSON.parse(message);
  } catch {
    return {};
  }
}

/**
 * Resolves a dimension id, falling back to overworld for debug convenience.
 *
 * @param {string} [id="overworld"] Dimension id.
 * @returns {import("@minecraft/server").Dimension}
 */
function getDimension(id = "overworld") {
  try {
    return world.getDimension(id);
  } catch {
    return world.getDimension("overworld");
  }
}

/**
 * Reads a block from command coordinates.
 *
 * @param {{dim?: string, x: number, y: number, z: number}} params Command params.
 * @returns {import("@minecraft/server").Block | undefined}
 */
function getBlockAt(params) {
  const dimension = getDimension(params.dim);
  return dimension.getBlock({
    x: Math.floor(Number(params.x) || 0),
    y: Math.floor(Number(params.y) || 0),
    z: Math.floor(Number(params.z) || 0),
  });
}

/**
 * Reads a block inventory container from command coordinates.
 *
 * @param {{dim?: string, x: number, y: number, z: number}} params Command params.
 * @returns {import("@minecraft/server").Container | undefined}
 */
function getContainerAt(params) {
  const block = getBlockAt(params);
  return block?.getComponent("inventory")?.container;
}

/**
 * Normalizes create-network drive coordinates from a debug payload.
 *
 * @param {object | object[]} params Parsed command params.
 * @returns {object[]} Drive coordinate entries.
 */
function getDriveParams(params) {
  const rootDim = !Array.isArray(params) && typeof params?.dim === "string" ? params.dim : undefined;
  const drives = Array.isArray(params)
    ? params
    : Array.isArray(params?.drives)
      ? params.drives
      : Array.isArray(params?.coords)
        ? params.coords
        : [params];

  return drives
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      ...entry,
      dim: entry.dim ?? rootDim ?? "overworld",
    }));
}

/**
 * Creates an online runtime network from storage cells found in one or more drives.
 *
 * This command simulates what a future network center will do after scanning
 * connected drives: collect cell ids, assign ownership, and build runtime state.
 */
function createNetworkFromDrives(event, params) {
  const driveParams = getDriveParams(params);
  if (driveParams.length === 0) {
    reply(event, "Usage: create_network_from_drives { drives:[{dim,x,y,z}, ...] }");
    return;
  }

  const cellIds = [];
  const ownedNetworkIds = new Set();
  const driveEntries = [];

  for (const driveParam of driveParams) {
    const block = getBlockAt(driveParam);
    const entity = getDriveEntity(block);
    if (!block || !entity) {
      reply(event, `No storage cell drive found at ${driveParam.dim}:${driveParam.x},${driveParam.y},${driveParam.z}`);
      return;
    }

    const snapshot = readDriveCells(entity);
    for (const cellId of snapshot.cellIds) cellIds.push(cellId);
    for (const networkId of snapshot.ownedNetworkIds) ownedNetworkIds.add(networkId);
    driveEntries.push({ block, entity, signature: snapshot.signature });
  }

  if (cellIds.length === 0) {
    reply(event, "No storage cells found in those drives.");
    return;
  }

  if (ownedNetworkIds.size > 1) {
    reply(event, `cells belong to multiple networks: ${[...ownedNetworkIds].join(", ")}`);
    return;
  }

  const existingNetworkId = [...ownedNetworkIds][0];
  const driveKeys = driveEntries.map(({ block }) => getDriveKey(block));
  const runtime = createNetworkFromCellIds(cellIds, {
    networkId: existingNetworkId,
    online: true,
    drives: driveKeys,
  });

  for (const { entity, signature } of driveEntries) {
    setDriveNetworkId(entity, runtime.networkId);
    setStoredDriveSignature(entity, signature);
  }

  reply(event, `created network ${runtime.networkId} from ${driveEntries.length} drive(s), ${cellIds.length} cells, capacity ${runtime.capacity}, used ${runtime.used}`);
}

/**
 * Adds a simple item key directly into a network.
 *
 * Useful for pure capacity/runtime tests without moving real ItemStacks.
 */
function addPlainItem(event, params) {
  const networkId = Math.floor(Number(params.networkId) || 0);
  const itemKey = String(params.itemKey || params.id || "");
  const amount = Math.max(1, Math.floor(Number(params.amount) || 1));
  if (!networkId || !itemKey) {
    reply(event, "Usage: add_item { networkId, id/itemKey, amount }");
    return;
  }

  const snapshot = getNetworkSnapshot(networkId);
  if (!snapshot) {
    reply(event, `network ${networkId} not found`);
    return;
  }
  if (!snapshot.online) {
    reply(event, `network ${networkId} is offline`);
    return;
  }
  const result = addItem(networkId, itemKey, amount, "debug_add_item");
  reply(event, `add ${itemKey}: inserted ${result.inserted}, remaining ${result.remaining}, unitDelta ${result.unitDelta ?? 0}, after ${result.after ?? "n/a"}`);
}

/**
 * Removes a simple item key directly from a network.
 */
function removePlainItem(event, params) {
  const networkId = Math.floor(Number(params.networkId) || 0);
  const itemKey = String(params.itemKey || params.id || "");
  const amount = Math.max(1, Math.floor(Number(params.amount) || 1));
  if (!networkId || !itemKey) {
    reply(event, "Usage: remove_item { networkId, id/itemKey, amount }");
    return;
  }

  const result = removeItem(networkId, itemKey, amount, "debug_remove_item");
  reply(event, `remove ${itemKey}: removed ${result.removed}, remaining request ${result.remaining}, after ${result.after ?? "n/a"}`);
}

/**
 * Stores a real item from a chest slot into a network.
 *
 * This is the main command for testing special item identity because the item
 * goes through `item_registry.getItemKey`.
 */
function addFromChest(event, params) {
  const networkId = Math.floor(Number(params.networkId) || 0);
  const slot = Math.floor(Number(params.slot) || 0);
  const container = getContainerAt(params);
  if (!networkId || !container) {
    reply(event, "Usage: add_from_chest { networkId, dim, x, y, z, slot }");
    return;
  }

  const item = container.getItem(slot);
  if (!item || isStorageCell(item)) {
    reply(event, "Target slot is empty or contains a storage cell.");
    return;
  }

  const itemKey = getItemKey(item);
  const snapshot = getNetworkSnapshot(networkId);
  if (!snapshot) {
    reply(event, `network ${networkId} not found`);
    return;
  }
  if (!snapshot.online) {
    reply(event, `network ${networkId} is offline`);
    return;
  }
  const result = addItemStack(networkId, item, "debug_add_from_chest");
  if (result.inserted <= 0) {
    const nextSnapshot = getNetworkSnapshot(networkId);
    reply(event, `could not store ${itemKey}; freeUnits=${nextSnapshot?.freeUnits ?? "unknown"}`);
    return;
  }

  if (result.remaining > 0) {
    item.amount = result.remaining;
    container.setItem(slot, item);
  } else {
    container.setItem(slot, undefined);
  }

  reply(event, `stored ${result.inserted}x ${itemKey}, remaining ${result.remaining}`);
}

/**
 * Removes items from a network and writes them into a chest.
 *
 * This validates that `item_registry.createItemFromKey` can rebuild stored
 * stacks after add/flush/reload cycles.
 */
function removeToChest(event, params) {
  const networkId = Math.floor(Number(params.networkId) || 0);
  const itemKey = String(params.itemKey || params.id || "");
  const amount = Math.max(1, Math.floor(Number(params.amount) || 1));
  const container = getContainerAt(params);
  if (!networkId || !itemKey || !container) {
    reply(event, "Usage: remove_to_chest { networkId, itemKey/id, amount, dim, x, y, z }");
    return;
  }

  const result = removeItem(networkId, itemKey, amount, "debug_remove_to_chest");
  if (result.removed <= 0) {
    reply(event, `No ${itemKey} available.`);
    return;
  }

  if (result.itemStack) {
    const overflow = container.addItem(result.itemStack);
    if (overflow) addItemStack(networkId, overflow, "debug_remove_to_chest_overflow");
    reply(event, "removed " + (overflow ? 0 : 1) + "x " + itemKey + " to chest, overflow restored " + (overflow ? 1 : 0));
    return;
  }

  let remaining = result.removed;
  while (remaining > 0) {
    const probe = createItemFromKey(itemKey, 1);
    const stackAmount = Math.min(remaining, probe.maxAmount ?? 64);
    const next = createItemFromKey(itemKey, stackAmount);
    const overflow = container.addItem(next);
    const accepted = stackAmount - (overflow?.amount ?? 0);
    remaining -= Math.max(0, accepted);
    if (overflow) break;
  }

  if (remaining > 0) addItem(networkId, itemKey, remaining, "debug_remove_to_chest_overflow");
  reply(event, `removed ${result.removed - remaining}x ${itemKey} to chest, overflow restored ${remaining}`);
}

/**
 * Prints network usage and top stored items.
 */
function printNetwork(event, params) {
  const networkId = Math.floor(Number(params.networkId) || 0);
  const snapshot = getNetworkSnapshot(networkId);
  if (!snapshot) {
    reply(event, `network ${networkId} not found`);
    return;
  }

  const top = getSortedItems(networkId).slice(0, Math.max(1, Math.floor(Number(params.limit) || 100)));
  reply(
    event,
    `network ${networkId}: state=${snapshot.state}, dirty=${snapshot.dirty}, items=${snapshot.itemCount}, types=${snapshot.typeCount}, bytes=${snapshot.usedUnits}/${snapshot.capacityUnits}, cells=${snapshot.cells.join(",") || "none"}`,
  );
  for (const [itemKey, amount] of top) {
    reply(event, ` - ${amount}x ${itemKey}`);
  }
}

/**
 * Prints one persistent cell record.
 */
function printCell(event, params) {
  const cellId = Math.floor(Number(params.cellId) || 0);
  const cell = readCellRecord(cellId);
  if (!cell) {
    reply(event, `cell ${cellId} not found`);
    return;
  }

  reply(event, `cell ${cellId}: network=${cell.networkId ?? "none"}, items=${cell.itemCount}, types=${cell.typeCount}, bytes=${cell.usedUnits}/${cell.capacityUnits}, schema=${cell.schemaVersion}`);
  for (const [itemKey, amount] of Object.entries(cell.items).slice(0, Math.max(1, Math.floor(Number(params.limit) || 10)))) {
    reply(event, ` - ${amount}x ${itemKey}`);
  }
}

/**
 * Script event command table.
 *
 * Commands are namespaced as `ucds:*` and are documented in `README.md`.
 */
const handlers = {
  "ucds:create_network_from_drives": createNetworkFromDrives,
  "ucds:add_item": addPlainItem,
  "ucds:remove_item": removePlainItem,
  "ucds:add_from_chest": addFromChest,
  "ucds:remove_to_chest": removeToChest,
  "ucds:print_network": printNetwork,
  "ucds:print_cell": printCell,
  "ucds:flush_network": (event, params) => {
    const networkId = Math.floor(Number(params.networkId) || 0);
    reply(event, flushNetwork(networkId) ? `flushed network ${networkId}` : `network ${networkId} not found`);
  },
  "ucds:power_off_network": (event, params) => {
    const networkId = Math.floor(Number(params.networkId) || 0);
    reply(
      event,
      powerOffNetwork(networkId)
        ? `powered off network ${networkId}; flushed cells, released ownership and deleted network record`
        : `network ${networkId} not found`,
    );
  },
  "ucds:power_off_all_networks": (event) => {
    const result = powerOffAllNetworks();
    reply(event, `powered off ${result.poweredOff} networks: ${result.networkIds.join(", ") || "none"}; cleaned stale ids ${result.stale}`);
  },
  "ucds:set_online": (event, params) => {
    const networkId = Math.floor(Number(params.networkId) || 0);
    const online = params.online !== false;
    reply(event, setNetworkOnline(networkId, online) ? `network ${networkId} online=${online}` : `network ${networkId} not found`);
  },
  "ucds:reload_network": (event, params) => {
    const networkId = Math.floor(Number(params.networkId) || 0);
    const runtime = reloadNetwork(networkId);
    reply(event, runtime ? `reloaded network ${networkId}` : `network ${networkId} not found`);
  },
};

system.afterEvents.scriptEventReceive.subscribe(
  (event) => {
    const handler = handlers[event.id];
    if (!handler) return;

    try {
      handler(event, parseMessage(event.message));
    } catch (error) {
      reply(event, `command failed: ${error?.message ?? error}`);
    }
  },
  { namespaces: ["ucds"] },
);
