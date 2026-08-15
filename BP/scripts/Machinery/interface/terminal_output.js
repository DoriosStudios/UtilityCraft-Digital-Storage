import { system, world } from "@minecraft/server";
import * as DoriosLib from "DoriosLib/index.js";
import { createItemFromKey } from "../storage/item_registry.js";
import { addItemStack, removeItem } from "../storage/network_runtime.js";

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
const SECTION = "\u00A7";
const UI_TOKEN_NAMESPACE = `${SECTION}d${SECTION}b`;
const UI_ELEMENT_TAG = "utilitycraft:ui_element";

const outputClaims = new Map();
const pendingUiSlotRestores = new Map();
let nextClaimId = 0;

/**
 * Encodes text as invisible formatting pairs.
 *
 * @param {string} text Plain text payload.
 * @returns {string} Formatting-code encoded payload.
 */
function encodeInvisible(text) {
  let encoded = "";
  for (let i = 0; i < text.length; i++) {
    const hex = text.charCodeAt(i).toString(16).padStart(2, "0");
    encoded += `§${hex[0]}§${hex[1]}`;
  }
  return encoded;
}

/**
 * Decodes text written by encodeInvisible.
 *
 * @param {string} encoded Formatting-code encoded payload.
 * @returns {string} Decoded text, or an empty string when invalid.
 */
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

/**
 * Creates a claim id that carries the source slot for cheap fallback parsing.
 *
 * @param {number} slot Source terminal grid slot.
 * @returns {string} Runtime claim id.
 */
function createClaimId(slot) {
  const slotPart = Math.max(0, Math.floor(Number(slot) || 0)).toString(36);
  const idPart = (nextClaimId++ % Number.MAX_SAFE_INTEGER).toString(36);
  return `${slotPart}.${idPart}`;
}

/**
 * Extracts the source slot embedded in a claim id.
 *
 * @param {string} claimId Runtime claim id.
 * @returns {number} Source slot, or -1 when invalid.
 */
function parseSlotFromClaimId(claimId) {
  const [slotPart] = String(claimId ?? "").split(".", 1);
  const slot = Number.parseInt(slotPart, 36);
  return Number.isFinite(slot) ? slot : -1;
}

/**
 * Creates the hidden lore marker for a terminal output item.
 *
 * @param {object} context Output token context.
 * @param {string} context.terminalId Terminal runtime id.
 * @param {string} context.claimId Runtime claim id.
 * @param {string|number} context.countText Displayed total count.
 * @returns {string} Hidden lore marker line.
 */
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

/**
 * Creates the hidden lore marker used by UI filler slots.
 *
 * @param {object} context UI slot token context.
 * @param {string} context.terminalId Terminal runtime id.
 * @param {number} context.slot Source terminal slot.
 * @returns {string} Hidden lore marker line.
 */
function createUiSlotLoreLine({ terminalId, slot }) {
  return [
    UI_TOKEN_NAMESPACE,
    TOKEN_SEPARATOR,
    encodeInvisible(String(terminalId)),
    TOKEN_SEPARATOR,
    encodeInvisible(String(Math.max(0, Math.floor(Number(slot) || 0)))),
  ].join("");
}

/**
 * Checks if an item is tagged as UI-only.
 *
 * @param {import("@minecraft/server").ItemStack|undefined} item Item to test.
 * @returns {boolean} True for UI-only items.
 */
function isUiElementItem(item) {
  if (!item) return false;
  try {
    if (item.hasTag?.(UI_ELEMENT_TAG)) return true;
  } catch {}
  try {
    return item.getTags?.().includes(UI_ELEMENT_TAG) === true;
  } catch {
    return false;
  }
}

/**
 * Queues a UI filler slot to be restored by its owning terminal tick.
 *
 * @param {{terminalId:string, slot:number}|undefined} token UI slot token.
 * @param {import("@minecraft/server").Player} [player] Player that moved the filler.
 */
function queueUiSlotRestore(token, player) {
  if (!token?.terminalId || token.slot < 0) return;

  let slots = pendingUiSlotRestores.get(token.terminalId);
  if (!slots) {
    slots = new Map();
    pendingUiSlotRestores.set(token.terminalId, slots);
  }
  slots.set(token.slot, player);
}

/**
 * Reads a safe positive requested amount from an ItemStack.
 *
 * @param {import("@minecraft/server").ItemStack|undefined} item ItemStack.
 * @returns {number} Requested amount.
 */
function getRequestedAmount(item) {
  return Math.max(0, Math.floor(Number(item?.amount) || 0));
}

/**
 * Reserves storage items for an output claim.
 *
 * Reservation happens while an item is on the cursor so later inventory/drop
 * resolution does not remove the same amount twice.
 *
 * @param {object} claim Runtime output claim.
 * @param {number} requestedAmount Amount requested by the visible stack.
 * @param {import("@minecraft/server").Player} [player] Player taking the output.
 * @returns {number} Total amount reserved for the request.
 */
function reserveClaimAmount(claim, requestedAmount, player) {
  const requested = Math.max(0, Math.floor(Number(requestedAmount) || 0));
  if (requested <= 0) return 0;

  const outstanding = Math.max(0, claim.reserved - claim.delivered);
  if (outstanding >= requested) {
    return requested;
  }

  const needed = requested - outstanding;
  const result = removeItem(claim.networkId, claim.itemKey, needed, "terminal_output");
  const removed = Math.max(0, Math.floor(Number(result.removed) || 0));
  if (result.itemStack) claim.reservedItem = result.itemStack;
  if (result.reason === "vault_missing" && player?.isValid && claim.vaultWarningSent !== true) {
    claim.vaultWarningSent = true;
    player.sendMessage({ translate: "message.utilitycraft:vault_missing" });
  }
  claim.reserved += removed;
  claim.updatedTick = system.currentTick;
  if (removed > 0) rescueSwappedTerminalSlotItem(claim, player);

  return Math.min(requested, outstanding + removed);
}

/**
 * Adds any item swapped into the source terminal slot back to the network.
 *
 * This runs only at the moment an output claim actually removes items from the
 * network. It deliberately does not clear or re-render the slot; the normal
 * terminal renderer owns that.
 *
 * @param {object} claim Runtime output claim.
 * @param {import("@minecraft/server").Player} [player] Player that performed the swap.
 */
function rescueSwappedTerminalSlotItem(claim, player) {
  if (claim?.swapRescued === true) return;

  const entity = claim?.entity;
  const slot = Math.max(0, Math.floor(Number(claim?.slot) || 0));
  const networkId = Math.floor(Number(claim?.networkId) || 0);
  if (!entity?.isValid || !networkId) return;

  const container = entity.getComponent("minecraft:inventory")?.container;
  const item = container?.getItem(slot);
  if (!item || isUiElementItem(item)) return;

  const outputToken = readOutputToken(item);
  if (outputToken?.terminalId === claim.terminalId && outputToken.claimId === claim.claimId) return;

  const materialized = materializeOutputItem(item, player);
  const rescuedItem = materialized.item ?? (!materialized.handled ? item : undefined);
  if (!rescuedItem) return;

  claim.swapRescued = true;
  const result = addItemStack(networkId, rescuedItem, "terminal_swap_rescue");
  if (result.remaining <= 0) return;

  rescuedItem.amount = result.remaining;
  if (player?.isValid) {
    DoriosLib.player.giveItem(player, { item: rescuedItem });
    return;
  }

  // Dropped output tokens have no owning player. Drop the remainder at the
  // terminal so a later UI render cannot overwrite a real item.
  try {
    entity.dimension.spawnItem(rescuedItem, entity.location);
  } catch {}
}

/**
 * Marks a reserved output amount as delivered to a real item destination.
 *
 * @param {object} claim Runtime output claim.
 * @param {number} requestedAmount Amount requested by the visible stack.
 * @param {import("@minecraft/server").Player} [player] Player taking the output.
 * @returns {number} Amount delivered.
 */
function deliverClaimAmount(claim, requestedAmount, player) {
  const deliverable = reserveClaimAmount(claim, requestedAmount, player);
  if (deliverable <= 0) return 0;

  claim.delivered += deliverable;
  claim.updatedTick = system.currentTick;
  return deliverable;
}

/**
 * Resolves an output token into a real item by removing from the network.
 *
 * @param {{terminalId:string, claimId:string, slot:number}} token Output token.
 * @param {number} requestedAmount Amount requested by the visible stack.
 * @param {import("@minecraft/server").Player} [player] Player taking the output.
 * @returns {{handled:boolean, item?:import("@minecraft/server").ItemStack, claim?:object}|undefined} Resolution result.
 */
function resolveClaim(token, requestedAmount, player) {
  const claim = outputClaims.get(token.claimId);
  if (!claim) return undefined;
  if (claim.terminalId !== token.terminalId) return undefined;

  const delivered = deliverClaimAmount(claim, requestedAmount, player);
  if (delivered <= 0) return { handled: true, item: undefined, claim };

  const item = claim.reservedItem ?? createItemFromKey(claim.itemKey, delivered);
  claim.reservedItem = undefined;
  return { handled: true, item, claim };
}

/**
 * Adds a hidden terminal output marker to one visual grid item.
 *
 * @param {import("@minecraft/server").ItemStack} item Display item.
 * @param {{terminalId:string, networkId:number, entity?:import("@minecraft/server").Entity, slot:number, itemKey:string, amount:number, totalCount:number|string}} context
 * @returns {import("@minecraft/server").ItemStack}
 */
export function attachOutputToken(item, context) {
  const claimId = createClaimId(context.slot);
  outputClaims.set(claimId, {
    claimId,
    terminalId: String(context.terminalId),
    networkId: Math.floor(Number(context.networkId) || 0),
    entity: context.entity,
    slot: Math.max(0, Math.floor(Number(context.slot) || 0)),
    itemKey: String(context.itemKey ?? ""),
    displayAmount: Math.max(1, Math.floor(Number(context.amount) || 1)),
    reserved: 0,
    delivered: 0,
    swapRescued: false,
    createdTick: system.currentTick,
    updatedTick: system.currentTick,
  });

  const lore = item.getLore?.() ?? [];
  const cleanLore = stripOutputTokenLore(lore);
  cleanLore.push(
    createTokenLoreLine({
      terminalId: context.terminalId,
      claimId,
      countText: String(context.totalCount),
    }),
  );
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

/**
 * Removes an output-token lore marker from a lore array.
 *
 * @param {string[]} [lore] Item lore.
 * @returns {string[]} Lore without the output marker.
 */
export function stripOutputTokenLore(lore = []) {
  if (lore.length === 0) return [];
  const lastLine = lore[lore.length - 1];
  if (typeof lastLine === "string" && lastLine.startsWith(TOKEN_NAMESPACE)) {
    return lore.slice(0, -1);
  }
  return [...lore];
}

/**
 * Adds hidden terminal/slot metadata to a UI filler item.
 *
 * @param {import("@minecraft/server").ItemStack} item UI filler item.
 * @param {{terminalId:string, slot:number}} context UI slot token context.
 * @returns {import("@minecraft/server").ItemStack} Tagged UI filler item.
 */
export function attachUiSlotToken(item, { terminalId, slot }) {
  if (!item || !terminalId) return item;

  const lore = stripUiSlotTokenLore(item.getLore?.() ?? []);
  lore.push(createUiSlotLoreLine({ terminalId, slot }));
  item.setLore(lore);
  return item;
}

/**
 * Reads hidden UI filler terminal/slot metadata.
 *
 * @param {import("@minecraft/server").ItemStack|undefined} item Item to inspect.
 * @returns {{terminalId:string, slot:number}|undefined} UI slot token.
 */
export function readUiSlotToken(item) {
  const lore = item?.getLore?.() ?? [];
  if (lore.length === 0) return undefined;

  const line = lore[lore.length - 1];
  if (typeof line !== "string" || !line.startsWith(UI_TOKEN_NAMESPACE)) return undefined;

  const parts = line.split(TOKEN_SEPARATOR);
  if (parts.length < 3 || parts[0] !== UI_TOKEN_NAMESPACE) return undefined;

  const terminalId = decodeInvisible(parts[1]);
  const slot = Math.floor(Number(decodeInvisible(parts[2])));
  if (!terminalId || !Number.isFinite(slot) || slot < 0) return undefined;

  return { terminalId, slot };
}

/**
 * Removes a UI-slot marker from a lore array.
 *
 * @param {string[]} [lore] Item lore.
 * @returns {string[]} Lore without the UI slot marker.
 */
export function stripUiSlotTokenLore(lore = []) {
  if (lore.length === 0) return [];
  const lastLine = lore[lore.length - 1];
  if (typeof lastLine === "string" && lastLine.startsWith(UI_TOKEN_NAMESPACE)) {
    return lore.slice(0, -1);
  }
  return [...lore];
}

/**
 * Consumes pending UI filler slot restores for one terminal.
 *
 * @param {string} terminalId Terminal runtime id.
 * @returns {Array<{slot:number, player?:import("@minecraft/server").Player}>} Pending restores.
 */
export function consumeUiSlotRestores(terminalId) {
  const id = String(terminalId ?? "");
  const slots = pendingUiSlotRestores.get(id);
  if (!slots) return [];

  pendingUiSlotRestores.delete(id);
  return [...slots.entries()].map(([slot, player]) => ({ slot, player }));
}

/**
 * Converts an output-token item into a real item, removing from the network if
 * that amount was not already reserved while the item was on the cursor.
 *
 * @param {import("@minecraft/server").ItemStack | undefined} item
 * @param {import("@minecraft/server").Player} [player] Player receiving the real item.
 * @returns {{handled:boolean, item?:import("@minecraft/server").ItemStack}}
 */
export function materializeOutputItem(item, player) {
  const token = readOutputToken(item);
  if (!token) return { handled: false, item };

  const resolved = resolveClaim(token, getRequestedAmount(item), player);
  if (!resolved) return { handled: true, item: undefined };
  return { handled: true, item: resolved.item };
}

/**
 * Resolves terminal-owned items when they enter a player inventory slot.
 *
 * Output items become real item stacks after removing from the network. UI-only
 * items are deleted and their source slot is queued for restoration.
 *
 * @param {import("@minecraft/server").Player} player Player whose inventory changed.
 * @param {number} slot Changed player inventory slot.
 * @param {import("@minecraft/server").ItemStack|undefined} item New slot item.
 */
function resolveInventoryItem(player, slot, item) {
  if (isUiElementItem(item)) {
    const outputToken = readOutputToken(item);
    if (outputToken) {
      materializeOutputItem(item, player);
    } else {
      const uiToken = readUiSlotToken(item);
      queueUiSlotRestore(uiToken, player);
    }

    const inventory = player.getComponent("minecraft:inventory")?.container;
    if (inventory && slot >= 0 && slot < inventory.size) {
      inventory.setItem(slot, undefined);
    }
    return;
  }

  const resolved = materializeOutputItem(item, player);
  if (!resolved.handled) return;

  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (!inventory || slot < 0 || slot >= inventory.size) return;

  inventory.setItem(slot, resolved.item);
}

/**
 * Resolves or removes terminal-owned items that become dropped item entities.
 *
 * @param {import("@minecraft/server").Entity} entity Spawned item entity.
 */
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

  if (isUiElementItem(item)) {
    const outputToken = readOutputToken(item);
    if (outputToken) {
      materializeOutputItem(item);
    } else {
      const uiToken = readUiSlotToken(item);
      queueUiSlotRestore(uiToken);
    }
    try {
      if (entity.isValid) entity.remove();
    } catch {}
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

/**
 * Periodically removes leaked UI-only items from a player's inventory.
 *
 * @param {import("@minecraft/server").Player} player Player to scan.
 */
function cleanupPlayerInventoryUiElements(player) {
  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (!inventory) return;

  for (let slot = 0; slot < inventory.size; slot++) {
    const item = inventory.getItem(slot);
    if (!isUiElementItem(item)) continue;

    const outputToken = readOutputToken(item);
    if (outputToken) {
      materializeOutputItem(item, player);
    } else {
      const uiToken = readUiSlotToken(item);
      queueUiSlotRestore(uiToken, player);
    }
    inventory.setItem(slot, undefined);
  }
}

/**
 * Watches cursor stacks for output reservations and UI-only item cleanup.
 */
function watchPlayerCursors() {
  for (const player of world.getAllPlayers()) {
    if (system.currentTick % 20 === 0) {
      cleanupPlayerInventoryUiElements(player);
    }

    let cursorItem;
    try {
      cursorItem = player.getComponent("minecraft:cursor_inventory")?.item;
    } catch {
      continue;
    }

    if (isUiElementItem(cursorItem)) {
      const outputToken = readOutputToken(cursorItem);
      if (outputToken) {
        materializeOutputItem(cursorItem, player);
      } else {
        const uiToken = readUiSlotToken(cursorItem);
        queueUiSlotRestore(uiToken, player);
      }
      try {
        player.getComponent("minecraft:cursor_inventory")?.clear();
      } catch {}
      continue;
    }

    const token = readOutputToken(cursorItem);
    if (!token) continue;

    const claim = outputClaims.get(token.claimId);
    if (!claim || claim.terminalId !== token.terminalId) continue;
    reserveClaimAmount(claim, getRequestedAmount(cursorItem), player);
  }
}

world.afterEvents.playerInventoryItemChange.subscribe(({ player, itemStack, slot }) => {
  resolveInventoryItem(player, slot, itemStack);
});

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  resolveDroppedItemEntity(entity);
});

system.runInterval(watchPlayerCursors, 1);
