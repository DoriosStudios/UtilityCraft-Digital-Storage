import { system, world } from "@minecraft/server";
import { createItemFromKey } from "../storage_v2/item_registry.js";
import { removeItem } from "../storage_v2/network_runtime.js";

/**
 * Runtime output-token resolver for storage terminals.
 *
 * Terminal grid items are normal ItemStacks with one hidden marker line appended
 * to their lore. The marker only stores terminal/claim ids; item identity stays
 * in this runtime claim map so visual items stay light and translated names are
 * untouched.
 */

const TOKEN_NAMESPACE = "§d§i";
const TOKEN_SEPARATOR = "§r";
const CLAIM_TTL_TICKS = 20 * 60 * 5;

const outputClaims = new Map();
let nextClaimId = 0;
let lastPruneTick = 0;

function encodeInvisible(text) {
  let encoded = "";
  for (let i = 0; i < text.length; i++) {
    const hex = text.charCodeAt(i).toString(16).padStart(2, "0");
    encoded += `§${hex[0]}§${hex[1]}`;
  }
  return encoded;
}

function decodeInvisible(encoded) {
  if (!encoded || encoded.length % 4 !== 0) return "";

  let text = "";
  for (let i = 0; i < encoded.length; i += 4) {
    if (encoded[i] !== "§" || encoded[i + 2] !== "§") return "";

    const value = Number.parseInt(`${encoded[i + 1]}${encoded[i + 3]}`, 16);
    if (!Number.isFinite(value)) return "";
    text += String.fromCharCode(value);
  }
  return text;
}

function createClaimId(slot) {
  const slotPart = Math.max(0, Math.floor(Number(slot) || 0)).toString(36);
  const idPart = (nextClaimId++ % Number.MAX_SAFE_INTEGER).toString(36);
  return `${slotPart}.${idPart}`;
}

function parseSlotFromClaimId(claimId) {
  const [slotPart] = String(claimId ?? "").split(".", 1);
  const slot = Number.parseInt(slotPart, 36);
  return Number.isFinite(slot) ? slot : -1;
}

function createTokenLoreLine({ terminalId, claimId, countText }) {
  return [
    TOKEN_NAMESPACE,
    TOKEN_SEPARATOR,
    encodeInvisible(String(terminalId)),
    TOKEN_SEPARATOR,
    encodeInvisible(String(claimId)),
    TOKEN_SEPARATOR,
    `§7Item Count: ${countText}`,
  ].join("");
}

function pruneClaims() {
  const tick = system.currentTick;
  if (tick - lastPruneTick < 20 * 30) return;

  lastPruneTick = tick;
  for (const [claimId, claim] of outputClaims.entries()) {
    if (tick - claim.updatedTick > CLAIM_TTL_TICKS) outputClaims.delete(claimId);
  }
}

function getRequestedAmount(item) {
  return Math.max(0, Math.floor(Number(item?.amount) || 0));
}

function reserveClaimAmount(claim, requestedAmount) {
  const requested = Math.max(0, Math.floor(Number(requestedAmount) || 0));
  if (requested <= 0) return 0;

  const outstanding = Math.max(0, claim.reserved - claim.delivered);
  if (outstanding >= requested) return requested;

  const needed = requested - outstanding;
  const result = removeItem(claim.networkId, claim.itemKey, needed, "terminal_output");
  const removed = Math.max(0, Math.floor(Number(result.removed) || 0));
  claim.reserved += removed;
  claim.updatedTick = system.currentTick;

  return Math.min(requested, outstanding + removed);
}

function deliverClaimAmount(claim, requestedAmount) {
  const deliverable = reserveClaimAmount(claim, requestedAmount);
  if (deliverable <= 0) return 0;

  claim.delivered += deliverable;
  claim.updatedTick = system.currentTick;
  return deliverable;
}

function resolveClaim(token, requestedAmount) {
  const claim = outputClaims.get(token.claimId);
  if (!claim) return undefined;
  if (claim.terminalId !== token.terminalId) return undefined;

  const delivered = deliverClaimAmount(claim, requestedAmount);
  if (delivered <= 0) return { handled: true, item: undefined, claim };

  const item = createItemFromKey(claim.itemKey, delivered);
  return { handled: true, item, claim };
}

/**
 * Adds a hidden terminal output marker to one visual grid item.
 *
 * @param {import("@minecraft/server").ItemStack} item Display item.
 * @param {{terminalId:string, networkId:number, slot:number, itemKey:string, amount:number, totalCount:number|string}} context
 * @returns {import("@minecraft/server").ItemStack}
 */
export function attachOutputToken(item, context) {
  pruneClaims();

  const claimId = createClaimId(context.slot);
  outputClaims.set(claimId, {
    claimId,
    terminalId: String(context.terminalId),
    networkId: Math.floor(Number(context.networkId) || 0),
    slot: Math.max(0, Math.floor(Number(context.slot) || 0)),
    itemKey: String(context.itemKey ?? ""),
    displayAmount: Math.max(1, Math.floor(Number(context.amount) || 1)),
    reserved: 0,
    delivered: 0,
    createdTick: system.currentTick,
    updatedTick: system.currentTick,
  });

  const lore = item.getLore?.() ?? [];
  const cleanLore = stripOutputTokenLore(lore);
  cleanLore.push(createTokenLoreLine({
    terminalId: context.terminalId,
    claimId,
    countText: String(context.totalCount),
  }));
  item.setLore(cleanLore);
  return item;
}

/**
 * Reads the hidden output marker from an ItemStack, when present.
 *
 * @param {import("@minecraft/server").ItemStack | undefined} item
 * @returns {{terminalId:string, claimId:string, slot:number} | undefined}
 */
export function readOutputToken(item) {
  const lore = item?.getLore?.() ?? [];
  if (lore.length === 0) return undefined;

  const line = lore[lore.length - 1];
  if (typeof line !== "string" || !line.startsWith(TOKEN_NAMESPACE)) return undefined;

  const parts = line.split(TOKEN_SEPARATOR);
  if (parts.length < 3 || parts[0] !== TOKEN_NAMESPACE) return undefined;

  const terminalId = decodeInvisible(parts[1]);
  const claimId = decodeInvisible(parts[2]);
  if (!terminalId || !claimId) return undefined;

  return {
    terminalId,
    claimId,
    slot: parseSlotFromClaimId(claimId),
  };
}

export function stripOutputTokenLore(lore = []) {
  if (lore.length === 0) return [];
  const lastLine = lore[lore.length - 1];
  if (typeof lastLine === "string" && lastLine.startsWith(TOKEN_NAMESPACE)) {
    return lore.slice(0, -1);
  }
  return [...lore];
}

/**
 * Converts an output-token item into a real item, removing from the network if
 * that amount was not already reserved while the item was on the cursor.
 *
 * @param {import("@minecraft/server").ItemStack | undefined} item
 * @returns {{handled:boolean, item?:import("@minecraft/server").ItemStack}}
 */
export function materializeOutputItem(item) {
  const token = readOutputToken(item);
  if (!token) return { handled: false, item };

  const resolved = resolveClaim(token, getRequestedAmount(item));
  if (!resolved) return { handled: true, item: undefined };
  return { handled: true, item: resolved.item };
}

function resolveInventoryItem(player, slot, item) {
  const resolved = materializeOutputItem(item);
  if (!resolved.handled) return;

  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (!inventory || slot < 0 || slot >= inventory.size) return;

  inventory.setItem(slot, resolved.item);
  if (resolved.item) {
    try {
      player.playSound("random.pop");
    } catch {}
  }
}

function resolveDroppedItemEntity(entity) {
  if (!entity?.isValid || entity.typeId !== "minecraft:item") return;

  let item;
  let dimension;
  let location;
  try {
    item = entity.getComponent("minecraft:item")?.itemStack;
    dimension = entity.dimension;
    location = entity.location;
  } catch {
    return;
  }

  const resolved = materializeOutputItem(item);
  if (!resolved.handled) return;

  try {
    if (entity.isValid) entity.remove();
  } catch {}

  if (resolved.item) {
    try {
      dimension.spawnItem(resolved.item, location);
    } catch {}
  }
}

function watchPlayerCursors() {
  pruneClaims();

  for (const player of world.getAllPlayers()) {
    let cursorItem;
    try {
      cursorItem = player.getComponent("minecraft:cursor_inventory")?.item;
    } catch {
      continue;
    }

    const token = readOutputToken(cursorItem);
    if (!token) continue;

    const claim = outputClaims.get(token.claimId);
    if (!claim || claim.terminalId !== token.terminalId) continue;
    reserveClaimAmount(claim, getRequestedAmount(cursorItem));
  }
}

world.afterEvents.playerInventoryItemChange.subscribe(({ player, itemStack, slot }) => {
  resolveInventoryItem(player, slot, itemStack);
});

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  resolveDroppedItemEntity(entity);
});

system.runInterval(watchPlayerCursors, 1);
