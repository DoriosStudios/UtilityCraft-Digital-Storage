import { system, world } from "@minecraft/server";
import { ensureCellId, isStorageCell, readCellRecord } from "./cell_store.js";
import {
  addItem,
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

/**
 * Temporary debug command surface for Storage V2.
 *
 * These commands exist so the database/runtime can be tested before terminal UI
 * is rebuilt. They should stay thin: parse command input, call the runtime API,
 * and print clear results. Real gameplay systems should import runtime helpers
 * directly instead of going through script events.
 */

function reply(event, message) {
  const text = `[DSv2] ${message}`;
  try {
    event.sourceEntity?.sendMessage?.(text);
  } catch {}
  console.warn(text);
}

/**
 * Parses JSON command payloads.
 *
 * Invalid or empty payloads intentionally become `{}` so commands can provide
 * their own usage messages.
 *
 * @param {string} message Raw script event message.
 * @returns {object} Parsed payload.
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
 * Reads a block inventory container from command coordinates.
 *
 * @param {{dim?: string, x: number, y: number, z: number}} params Command params.
 * @returns {import("@minecraft/server").Container | undefined}
 */
function getContainerAt(params) {
  const dimension = getDimension(params.dim);
  const block = dimension.getBlock({
    x: Math.floor(Number(params.x) || 0),
    y: Math.floor(Number(params.y) || 0),
    z: Math.floor(Number(params.z) || 0),
  });
  return block?.getComponent("inventory")?.container;
}

/**
 * Creates an online runtime network from storage cells found in a chest.
 *
 * This command simulates what a future network center will do after scanning
 * connected drives: collect cell ids, assign ownership, and build runtime state.
 */
function createNetworkFromChest(event, params) {
  const container = getContainerAt(params);
  if (!container) {
    reply(event, "No container found at target coords.");
    return;
  }

  const cellIds = [];
  const ownedNetworkIds = new Set();
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!isStorageCell(item)) continue;
    const cellId = ensureCellId(item);
    if (!cellId) continue;
    container.setItem(slot, item);
    cellIds.push(cellId);
    const record = readCellRecord(cellId);
    if (record?.networkId) ownedNetworkIds.add(record.networkId);
  }

  if (cellIds.length === 0) {
    reply(event, "No storage cells found in that container.");
    return;
  }

  if (ownedNetworkIds.size > 1) {
    reply(event, `cells belong to multiple networks: ${[...ownedNetworkIds].join(", ")}`);
    return;
  }

  const existingNetworkId = [...ownedNetworkIds][0];
  if (existingNetworkId) {
    const runtime = reloadNetwork(existingNetworkId);
    if (!runtime) {
      reply(event, `network ${existingNetworkId} could not be loaded`);
      return;
    }
    setNetworkOnline(existingNetworkId, true);
    reply(event, `reused network ${existingNetworkId} with ${cellIds.length} cells, capacity ${runtime.capacity}, used ${runtime.used}`);
    return;
  }

  const runtime = createNetworkFromCellIds(cellIds, { online: true });
  reply(event, `created network ${runtime.networkId} with ${cellIds.length} cells, capacity ${runtime.capacity}, used ${runtime.used}`);
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
  if (snapshot.free <= 0) {
    reply(event, `network ${networkId} is full (${snapshot.used}/${snapshot.capacity})`);
    return;
  }

  const result = addItem(networkId, itemKey, amount, "debug_add_item");
  reply(event, `add ${itemKey}: inserted ${result.inserted}, remaining ${result.remaining}, after ${result.after ?? "n/a"}`);
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
  if (snapshot.free <= 0) {
    reply(event, `network ${networkId} is full (${snapshot.used}/${snapshot.capacity})`);
    return;
  }

  const result = addItem(networkId, itemKey, item.amount, "debug_add_from_chest");
  if (result.inserted <= 0) {
    const nextSnapshot = getNetworkSnapshot(networkId);
    reply(event, `could not store ${itemKey}; free=${nextSnapshot?.free ?? "unknown"}`);
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
    `network ${networkId}: online=${snapshot.online}, dirty=${snapshot.dirty}, used=${snapshot.used}/${snapshot.capacity}, cells=${snapshot.cells.join(",") || "none"}`,
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

  reply(event, `cell ${cellId}: network=${cell.networkId ?? "none"}, used=${cell.used}/${cell.capacity}`);
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
  "ucds:create_network_from_chest": createNetworkFromChest,
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
