import { ItemStack, world } from "@minecraft/server";

const SECTION = "\u00A7";
const FILLER_METADATA_PREFIX = `${SECTION}n${SECTION}u${SECTION}f${SECTION}r`;

export const RESTORABLE_FILLER_TYPES = new Set([
  "utilitycraft:ui_filler",
  "utilitycraft:storage_filler",
]);

function encodeMetadata(entityId, slot, nameTag) {
  const payload = encodeURIComponent(JSON.stringify({
    e: entityId,
    s: slot,
    n: nameTag ?? " ",
  }));

  let encoded = "";
  for (const char of payload) {
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    encoded += `${SECTION}${hex[0]}${SECTION}${hex[1]}`;
  }
  return `${FILLER_METADATA_PREFIX}${encoded}`;
}

function decodeMetadata(line) {
  const metadataIndex =
    typeof line === "string" ? line.indexOf(FILLER_METADATA_PREFIX) : -1;
  if (metadataIndex < 0) return undefined;

  const encoded = line.slice(metadataIndex + FILLER_METADATA_PREFIX.length);
  let hex = "";
  for (let i = 0; i < encoded.length - 1; i++) {
    if (encoded[i] === SECTION && /[0-9a-f]/i.test(encoded[i + 1])) {
      hex += encoded[i + 1];
      i++;
    }
  }
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;

  let payload = "";
  for (let i = 0; i < hex.length; i += 2) {
    payload += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }

  try {
    const data = JSON.parse(decodeURIComponent(payload));
    if (typeof data.e !== "string") return undefined;
    if (!Number.isInteger(data.s) || data.s < 0) return undefined;
    return {
      entityId: data.e,
      slot: data.s,
      nameTag: typeof data.n === "string" ? data.n : " ",
    };
  } catch {
    return undefined;
  }
}

export function createTaggedFiller(typeId, nameTag, entityOrId, slot) {
  const item = new ItemStack(typeId, 1);
  item.nameTag = nameTag;

  const entityId =
    typeof entityOrId === "string" ? entityOrId : entityOrId?.id;
  if (entityId && Number.isInteger(slot) && slot >= 0) {
    item.setLore([encodeMetadata(entityId, slot, nameTag)]);
  }

  return item;
}

export function readFillerRestoreData(item) {
  if (!item || !RESTORABLE_FILLER_TYPES.has(item.typeId)) return undefined;

  for (const line of item.getLore?.() ?? []) {
    const metadata = decodeMetadata(line);
    if (!metadata) continue;
    return {
      ...metadata,
      typeId: item.typeId,
      nameTag: metadata.nameTag ?? item.nameTag ?? " ",
    };
  }

  return undefined;
}

export function restoreTaggedFiller(data) {
  if (!data) return false;

  const entity = world.getEntity(data.entityId);
  if (!entity?.isValid) return false;

  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return false;

  const current = container.getItem(data.slot);
  if (current && current.typeId !== data.typeId) return false;

  container.setItem(
    data.slot,
    createTaggedFiller(data.typeId, data.nameTag, data.entityId, data.slot),
  );
  return true;
}
