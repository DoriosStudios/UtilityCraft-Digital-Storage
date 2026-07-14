import { system } from "@minecraft/server";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import {
  DRIVE_ENTITY_TYPE,
  DRIVE_SLOT_COUNT,
  getDriveEntity,
  getDriveKey,
  getDriveNetworkId,
  getStoredDriveSignature,
  readDriveCellSignature,
  readDriveCells,
  setDriveNetworkId,
  setStoredDriveSignature,
} from "../drive_cells.js";
import { getNetwork, powerOffNetwork, reloadNetwork } from "../network_runtime.js";

/**
 * Drops every item currently stored in the drive helper entity.
 *
 * @param {import("@minecraft/server").Entity} entity Drive entity.
 * @param {import("@minecraft/server").Block} block Drive block.
 */
function dropDriveInventory(entity, block) {
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

/**
 * Powers off the drive's linked network and unlinks the drive entity.
 *
 * @param {import("@minecraft/server").Entity} entity Drive entity.
 * @returns {number} Network id that was requested to power off.
 */
function powerOffLinkedNetwork(entity) {
  const networkId = getDriveNetworkId(entity);
  if (!networkId) return 0;

  if (!powerOffNetwork(networkId)) {
    reloadNetwork(networkId);
    powerOffNetwork(networkId);
  }
  setDriveNetworkId(entity, 0);
  return networkId;
}

/**
 * Tracks physical cell changes. The drive stays intentionally simple: when its
 * inventory changes while linked to a network, the network is shut down so a
 * future center can rebuild topology from a clean state.
 *
 * @param {import("@minecraft/server").Entity} entity Drive entity.
 */
function tickDrive(entity) {
  const networkId = getDriveNetworkId(entity);
  if (!networkId) return;

  const runtime = getNetwork(networkId);
  if (!runtime?.online) return;

  const signature = readDriveCellSignature(entity);
  const previousSignature = getStoredDriveSignature(entity);

  if (previousSignature === undefined) {
    setStoredDriveSignature(entity, signature);
    return;
  }

  if (previousSignature === signature) return;

  powerOffLinkedNetwork(entity);
  setStoredDriveSignature(entity, signature);

  if (networkId) {
    // console.warn(`[DSv2] storage cell drive changed; powered off network ${networkId}.`);
  }
}

DoriosAPI.register.blockComponent("storage_cell_drive", {
  onPlace({ block }) {
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: DRIVE_ENTITY_TYPE,
          inventory_size: DRIVE_SLOT_COUNT,
          name: "storage_cell_drive",
        },
      });

      const snapshot = readDriveCells(entity);
      setStoredDriveSignature(entity, snapshot.signature);
      entity.setDynamicProperty("ucds:drive_key", getDriveKey(block));
    });
  },

  onTick({ block }) {
    const entity = getDriveEntity(block);
    if (!entity?.isValid) return;
    tickDrive(entity);
  },

  onPlayerBreak({ block }) {
    const entity = getDriveEntity(block);
    if (!entity?.isValid) return;

    powerOffLinkedNetwork(entity);
    dropDriveInventory(entity, block);
    entity.triggerEvent("despawn");
  },
});
