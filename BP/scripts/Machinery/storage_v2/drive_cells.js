import { ensureCellId, getCellId, isStorageCell, readCellRecord } from "./cell_store.js";

export const DRIVE_ENTITY_TYPE = "utilitycraft:storage_cell_drive";
export const DRIVE_SLOT_COUNT = 16;
export const DRIVE_NETWORK_ID_PROPERTY = "ucds:network_id";
export const DRIVE_SIGNATURE_PROPERTY = "ucds:drive_signature";

/**
 * Builds the stable coordinate key stored in network records for one drive.
 *
 * @param {import("@minecraft/server").Block} block Drive block.
 * @returns {string} Stable drive location key.
 */
export function getDriveKey(block) {
  return `${block.dimension.id}:${block.location.x},${block.location.y},${block.location.z}`;
}

/**
 * Finds the storage-cell-drive entity bound to a block location.
 *
 * @param {import("@minecraft/server").Block | undefined} block Candidate block.
 * @returns {import("@minecraft/server").Entity | undefined} Drive entity.
 */
export function getDriveEntity(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === DRIVE_ENTITY_TYPE);
}

/**
 * Reads the network id stored on a drive entity.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Drive entity.
 * @returns {number} Linked network id, or 0 when unlinked.
 */
export function getDriveNetworkId(entity) {
  try {
    const value = Math.floor(Number(entity?.getDynamicProperty?.(DRIVE_NETWORK_ID_PROPERTY)) || 0);
    return value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Stores the linked network id on a drive entity.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Drive entity.
 * @param {number} networkId Network id, or 0 to unlink.
 * @returns {void}
 */
export function setDriveNetworkId(entity, networkId) {
  if (!entity?.isValid) return;

  try {
    const cleanId = Math.floor(Number(networkId) || 0);
    entity.setDynamicProperty(DRIVE_NETWORK_ID_PROPERTY, cleanId > 0 ? cleanId : undefined);
  } catch {}
}

/**
 * Reads and optionally initializes the cells in a drive inventory.
 *
 * Storage cells receive persistent ids when first seen. Non-cell items are
 * ignored for network creation but still included in the signature so the
 * drive can notice any physical inventory change and shut down its network.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Drive entity.
 * @returns {{cellIds:number[], ownedNetworkIds:Set<number>, signature:string}} Drive inventory snapshot.
 */
export function readDriveCells(entity) {
  const container = entity?.getComponent("minecraft:inventory")?.container;
  if (!container) {
    return { cellIds: [], ownedNetworkIds: new Set(), signature: "" };
  }

  const cellIds = [];
  const ownedNetworkIds = new Set();
  const signatureParts = [];
  const size = Math.min(DRIVE_SLOT_COUNT, container.size);

  for (let slot = 0; slot < size; slot++) {
    const item = container.getItem(slot);
    if (!item) {
      signatureParts.push(`${slot}:-`);
      continue;
    }

    if (!isStorageCell(item)) {
      signatureParts.push(`${slot}:${item.typeId}@${item.amount}`);
      continue;
    }

    const cellId = ensureCellId(item);
    if (cellId) {
      container.setItem(slot, item);
      cellIds.push(cellId);

      const record = readCellRecord(cellId);
      if (record?.networkId) ownedNetworkIds.add(record.networkId);
    }

    signatureParts.push(`${slot}:${item.typeId}#${cellId ?? "new"}`);
  }

  return {
    cellIds: [...new Set(cellIds)],
    ownedNetworkIds,
    signature: signatureParts.join("|"),
  };
}

/**
 * Builds a cheap physical inventory signature for online drive monitoring.
 *
 * Unlike `readDriveCells`, this does not allocate cell ids, write ItemStacks, or
 * read persistent cell records. It only looks at the current visible stack shape
 * so the drive can detect that topology changed and power off its network.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Drive entity.
 * @returns {string} Lightweight drive signature.
 */
export function readDriveCellSignature(entity) {
  const container = entity?.getComponent("minecraft:inventory")?.container;
  if (!container) return "";

  const signatureParts = [];
  const size = Math.min(DRIVE_SLOT_COUNT, container.size);

  for (let slot = 0; slot < size; slot++) {
    const item = container.getItem(slot);
    if (!item) {
      signatureParts.push(`${slot}:-`);
      continue;
    }

    if (!isStorageCell(item)) {
      signatureParts.push(`${slot}:${item.typeId}@${item.amount}`);
      continue;
    }

    signatureParts.push(`${slot}:${item.typeId}#${getCellId(item) ?? "new"}`);
  }

  return signatureParts.join("|");
}

/**
 * Reads the last stored drive signature.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Drive entity.
 * @returns {string | undefined} Stored signature.
 */
export function getStoredDriveSignature(entity) {
  try {
    const value = entity?.getDynamicProperty?.(DRIVE_SIGNATURE_PROPERTY);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores the current drive signature.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity Drive entity.
 * @param {string} signature Signature to store.
 * @returns {void}
 */
export function setStoredDriveSignature(entity, signature) {
  if (!entity?.isValid) return;

  try {
    entity.setDynamicProperty(DRIVE_SIGNATURE_PROPERTY, signature);
  } catch {}
}
