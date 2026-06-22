import { system, world } from "@minecraft/server";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import { StorageTerminalInterface } from "../../interface/terminal.js";

const terminal = new StorageTerminalInterface({
  machineId: "storage_terminal",
  entityType: "utilitycraft:storage_terminal",
  burnSlots: [0, 1, 2, 3],
  visibleBurnSlot: 0,
  gridStart: 4,
  gridColumns: 9,
  gridRows: 18,
  reloadSlot: 166,
  previousSlot: 167,
  nextSlot: 168,
  countLabelBaseSlot: 169,
  countLabelColumns: 9,
  countLabelRows: 18,
});

terminal.registerButtons();

/**
 * Finds the terminal backing entity sitting on a terminal block.
 *
 * @param {import("@minecraft/server").Block} block Terminal block.
 * @returns {import("@minecraft/server").Entity|undefined} Terminal entity.
 */
function getTerminalEntity(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === terminal.entityType);
}

/**
 * Gets a dimension by id, falling back to overworld for debug commands.
 *
 * @param {string} [id="overworld"] Dimension id.
 * @returns {import("@minecraft/server").Dimension} Dimension instance.
 */
function getDimension(id = "overworld") {
  try {
    return world.getDimension(id);
  } catch {
    return world.getDimension("overworld");
  }
}

/**
 * Sends script-event feedback to the caller and console.
 *
 * @param {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} event Script event.
 * @param {string} message Message body.
 */
function reply(event, message) {
  const text = `[DSv2] ${message}`;
  try {
    event.sourceEntity?.sendMessage?.(text);
  } catch {}
  console.warn(text);
}

/**
 * Parses a JSON script-event payload.
 *
 * @param {string} message Raw event message.
 * @returns {object} Parsed payload, or an empty object on failure.
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
 * Debug helper that links a terminal entity at coordinates to a network id.
 *
 * @param {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} event Script event.
 * @param {object} params Parsed payload.
 */
function linkTerminal(event, params) {
  const networkId = Math.floor(Number(params.networkId ?? params.id) || 0);
  const dimension = getDimension(params.dim);
  const location = {
    x: Math.floor(Number(params.x) || 0),
    y: Math.floor(Number(params.y) || 0),
    z: Math.floor(Number(params.z) || 0),
  };
  const block = dimension.getBlock(location);
  const entity = block ? getTerminalEntity(block) : undefined;

  if (!networkId) {
    reply(event, "Usage: link_terminal { networkId, dim, x, y, z }");
    return;
  }
  if (!entity) {
    reply(event, "No storage terminal entity found at target coords.");
    return;
  }

  terminal.linkNetwork(entity, networkId);
  terminal.tick(entity);
  reply(event, `linked storage terminal at ${location.x},${location.y},${location.z} to network ${networkId}`);
}

DoriosAPI.register.blockComponent("storage_terminal", {
  onPlace({ block }) {
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: terminal.entityType,
          inventory_size: 178,
          name: "storage_terminal",
        },
      });
      terminal.setupEntity(entity);
    });
  },

  onTick({ block }) {
    const entity = getTerminalEntity(block);
    if (!entity?.isValid) return;
    terminal.tick(entity, block);
  },

  onPlayerBreak({ block }) {
    const entity = getTerminalEntity(block);
    if (!entity?.isValid) return;

    terminal.destroyEntity(entity);
    const inv = entity.getComponent("minecraft:inventory")?.container;
    inv?.clearAll();
    entity.triggerEvent("despawn");
  },
});

system.afterEvents.scriptEventReceive.subscribe(
  (event) => {
    if (event.id !== "ucds:link_terminal") return;

    try {
      linkTerminal(event, parseMessage(event.message));
    } catch (error) {
      reply(event, `link_terminal failed: ${error?.message ?? error}`);
    }
  },
  { namespaces: ["ucds"] },
);
