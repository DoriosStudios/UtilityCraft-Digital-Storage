import { ItemLockMode, ItemStack, system, world } from "@minecraft/server";
import { ButtonManager, TickScheduler } from "DoriosCore/index.js";
import * as DoriosLib from "DoriosLib/index.js";
import {
  cancelCraftingRecipeResolution,
  CRAFTING_TERMINAL_CONFIG,
  CraftingTerminalInterface,
} from "../../interface/crafting_terminal.js";
import { StorageTerminalInterface, STORAGE_TERMINAL_CONFIG } from "../../interface/terminal.js";
import { materializeOutputItem, readOutputToken } from "../../interface/terminal_output.js";
import { addItemStack, getOnlineNetworkByCenter } from "../network_runtime.js";
import { checkWirelessAccess } from "../wireless_access.js";

const DIMENSION_IDS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const STORAGE_CENTER_ENTITY_TYPE = "utilitycraft:storage_center";
const WIRELESS_PANEL_OFF = "utilitycraft:wireless_panel_off";
const WIRELESS_PANEL_ON = "utilitycraft:wireless_panel_on";
const WIRELESS_CRAFTING_PANEL_OFF = "utilitycraft:wireless_crafting_panel_off";
const WIRELESS_CRAFTING_PANEL_ON = "utilitycraft:wireless_crafting_panel_on";
const WIRELESS_TERMINAL_ENTITY_TYPE = "utilitycraft:wireless_storage_terminal";
const WIRELESS_CENTER_PROPERTY = "ucds:wireless_center";
const WIRELESS_MODE_PROPERTY = "ucds:wireless_mode";
const STORAGE_MODE = "storage";
const CRAFTING_MODE = "crafting";
const UPDATE_INTERVAL_TICKS = 1;
const BIND_COOLDOWN_TICKS = 5;

const PANEL_PROFILES = Object.freeze({
  [WIRELESS_PANEL_OFF]: Object.freeze({
    mode: STORAGE_MODE,
    onId: WIRELESS_PANEL_ON,
    entityName: "entity.utilitycraft:storage_terminal.name",
  }),
  [WIRELESS_PANEL_ON]: Object.freeze({
    mode: STORAGE_MODE,
    onId: WIRELESS_PANEL_ON,
    entityName: "entity.utilitycraft:storage_terminal.name",
  }),
  [WIRELESS_CRAFTING_PANEL_OFF]: Object.freeze({
    mode: CRAFTING_MODE,
    onId: WIRELESS_CRAFTING_PANEL_ON,
    entityName: "entity.utilitycraft:crafting_terminal.name",
  }),
  [WIRELESS_CRAFTING_PANEL_ON]: Object.freeze({
    mode: CRAFTING_MODE,
    onId: WIRELESS_CRAFTING_PANEL_ON,
    entityName: "entity.utilitycraft:crafting_terminal.name",
  }),
});

const TRACKING_OPTIONS = Object.freeze({
  anchor: "head",
  viewOffset: 0.5,
  velocityFactor: 5,
  offset: Object.freeze({ x: 0, y: -0.5, z: 0 }),
});

const WIRELESS_STORAGE_CONFIG = {
  ...STORAGE_TERMINAL_CONFIG,
  machineId: "wireless_storage_terminal",
  entityType: WIRELESS_TERMINAL_ENTITY_TYPE,
};

const WIRELESS_CRAFTING_CONFIG = {
  ...CRAFTING_TERMINAL_CONFIG,
  machineId: "wireless_crafting_terminal",
  entityType: WIRELESS_TERMINAL_ENTITY_TYPE,
};

const activePanels = new Map();
const lastStatusByPlayer = new Map();
const lastBindTickByPlayer = new Map();
const recoveryCheckedPlayers = new Set();
const lockedPanelSlotByPlayer = new Map();
const panelLockRecoveryCheckedPlayers = new Set();
const pendingCleanupPanels = new Map();

class WirelessStorageTerminalInterface extends StorageTerminalInterface {
  static get config() {
    return WIRELESS_STORAGE_CONFIG;
  }
}

class WirelessCraftingTerminalInterface extends CraftingTerminalInterface {
  static get config() {
    return WIRELESS_CRAFTING_CONFIG;
  }

  deliverItemStack(stack) {
    const player = getTerminalOwner(this.entity);
    if (player?.isValid) {
      DoriosLib.player.giveItem(player, { item: stack });
      return;
    }
    super.deliverItemStack(stack);
  }
}

WirelessStorageTerminalInterface.registerButtons();
WirelessCraftingTerminalInterface.registerButtons();

function getPanelProfile(itemOrTypeId) {
  const typeId = typeof itemOrTypeId === "string" ? itemOrTypeId : itemOrTypeId?.typeId;
  return PANEL_PROFILES[typeId];
}

function isActivePanel(item) {
  const profile = getPanelProfile(item);
  return Boolean(profile && item?.typeId === profile.onId);
}

function getEntityMode(entity) {
  return entity?.getDynamicProperty(WIRELESS_MODE_PROPERTY) === CRAFTING_MODE
    ? CRAFTING_MODE
    : STORAGE_MODE;
}

function getWirelessTerminal(entity, mode = getEntityMode(entity)) {
  const TerminalClass = mode === CRAFTING_MODE
    ? WirelessCraftingTerminalInterface
    : WirelessStorageTerminalInterface;
  const block = TerminalClass.getBlock(entity);
  return block ? new TerminalClass(block, entity) : undefined;
}

function getTerminalOwner(entity) {
  const ownerId = entity?.getComponent("minecraft:tameable")?.tamedToPlayerId;
  if (!ownerId) return undefined;
  return world.getAllPlayers().find((player) => player.id === ownerId);
}

function findWirelessTerminal(playerId, preferredDimension) {
  const dimensions = [];
  const usedDimensionIds = new Set();
  if (preferredDimension) {
    dimensions.push(preferredDimension);
    usedDimensionIds.add(preferredDimension.id);
  }
  for (const dimensionId of DIMENSION_IDS) {
    if (usedDimensionIds.has(dimensionId)) continue;
    dimensions.push(world.getDimension(dimensionId));
  }

  for (const dimension of dimensions) {
    const entity = dimension.getEntities({
      type: WIRELESS_TERMINAL_ENTITY_TYPE,
      tags: [playerId],
    })[0];
    if (entity) return entity;
  }
  return undefined;
}

function recoverWirelessTerminal(playerId, preferredDimension) {
  if (recoveryCheckedPlayers.has(playerId)) return undefined;
  recoveryCheckedPlayers.add(playerId);
  return findWirelessTerminal(playerId, preferredDimension);
}

function setPanelSlotLock(inventory, slot, lockMode) {
  const item = inventory?.getItem(slot);
  if (!isActivePanel(item)) return item;
  if (item.lockMode === lockMode) return item;

  item.lockMode = lockMode;
  inventory.setItem(slot, item);
  return item;
}

function recoverPanelSlotLocks(player, inventory, selectedSlot) {
  if (panelLockRecoveryCheckedPlayers.has(player.id)) return;
  panelLockRecoveryCheckedPlayers.add(player.id);

  for (let slot = 0; slot < inventory.size; slot++) {
    if (slot === selectedSlot) continue;
    const item = inventory.getItem(slot);
    if (!isActivePanel(item) || item.lockMode !== ItemLockMode.slot) continue;
    setPanelSlotLock(inventory, slot, ItemLockMode.none);
  }
}

/**
 * Locks an active Wireless Panel only while it is the selected main-hand item.
 * The previous selected panel is unlocked as soon as the player changes slots.
 */
function syncHeldPanelSlotLock(player) {
  const inventory = player?.getComponent("minecraft:inventory")?.container;
  if (!inventory) return undefined;

  const selectedSlot = player.selectedSlotIndex ?? 0;
  recoverPanelSlotLocks(player, inventory, selectedSlot);

  const previousSlot = lockedPanelSlotByPlayer.get(player.id);
  if (previousSlot !== undefined && previousSlot !== selectedSlot) {
    setPanelSlotLock(inventory, previousSlot, ItemLockMode.none);
    lockedPanelSlotByPlayer.delete(player.id);
  }

  let heldItem = inventory.getItem(selectedSlot);
  if (!isActivePanel(heldItem)) {
    if (previousSlot === selectedSlot) lockedPanelSlotByPlayer.delete(player.id);
    return heldItem;
  }

  heldItem = setPanelSlotLock(inventory, selectedSlot, ItemLockMode.slot);
  lockedPanelSlotByPlayer.set(player.id, selectedSlot);
  return heldItem;
}

function getCenterKey(entity) {
  const location = entity.location;
  return `${entity.dimension.id}:${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}`;
}

function showStatusOnce(player, status, translationKey) {
  if (lastStatusByPlayer.get(player.id) === status) return;
  lastStatusByPlayer.set(player.id, status);
  player.sendMessage({ translate: translationKey });
}

function copyItemData(source, target) {
  if (typeof source.nameTag === "string") target.nameTag = source.nameTag;

  const lore = source.getLore?.() ?? [];
  if (lore.length > 0) target.setLore(lore);

  for (const propertyId of source.getDynamicPropertyIds?.() ?? []) {
    target.setDynamicProperty(propertyId, source.getDynamicProperty(propertyId));
  }
}

function bindHeldPanel(player, centerEntity) {
  if (!player?.isValid || !centerEntity?.isValid) return false;

  const centerKey = getCenterKey(centerEntity);
  if (!getOnlineNetworkByCenter(centerKey)) {
    player.sendMessage({ translate: "message.utilitycraft:wireless_network_unavailable" });
    return false;
  }

  const inventory = player.getComponent("minecraft:inventory")?.container;
  const slot = player.selectedSlotIndex ?? 0;
  const heldItem = inventory?.getItem(slot);
  const profile = getPanelProfile(heldItem);
  if (!profile) return false;

  const linkedItem = heldItem.typeId === profile.onId
    ? heldItem
    : new ItemStack(profile.onId, 1);
  if (linkedItem !== heldItem) copyItemData(heldItem, linkedItem);
  linkedItem.setDynamicProperty(WIRELESS_CENTER_PROPERTY, centerKey);
  linkedItem.lockMode = ItemLockMode.slot;

  const previousSlot = lockedPanelSlotByPlayer.get(player.id);
  if (previousSlot !== undefined && previousSlot !== slot) {
    setPanelSlotLock(inventory, previousSlot, ItemLockMode.none);
  }

  inventory.setItem(slot, linkedItem);
  lockedPanelSlotByPlayer.set(player.id, slot);
  lastStatusByPlayer.delete(player.id);
  player.sendMessage({ translate: "message.utilitycraft:wireless_linked" });
  return true;
}

function spawnWirelessTerminal(player, centerKey, networkId, profile) {
  let entity = recoverWirelessTerminal(player.id, player.dimension);
  const isNew = !entity?.isValid;
  try {
    if (isNew) {
      entity = player.dimension.spawnEntity(WIRELESS_TERMINAL_ENTITY_TYPE, player.location);
      entity.addTag(player.id);
    }

    entity.nameTag = profile.entityName;
    entity.setDynamicProperty(WIRELESS_CENTER_PROPERTY, centerKey);
    entity.setDynamicProperty(WIRELESS_MODE_PROPERTY, profile.mode);
    const tameable = entity.getComponent("minecraft:tameable");
    if (!tameable || (
      tameable.tamedToPlayerId !== player.id
      && tameable.tame(player) !== true
      && tameable.tamedToPlayerId !== player.id
    )) {
      entity.remove();
      return undefined;
    }

    const terminal = getWirelessTerminal(entity, profile.mode);
    if (!terminal?.valid) {
      entity.remove();
      return undefined;
    }

    if (isNew) terminal.setup();
    terminal.linkNetwork(networkId);
    DoriosLib.entity.startPlayerTracking(entity, player, TRACKING_OPTIONS);
    activePanels.set(player.id, entity);
    recoveryCheckedPlayers.add(player.id);
    return entity;
  } catch {
    try {
      if (entity?.isValid) entity.remove();
    } catch {}
    return undefined;
  }
}

function routeRemainingItem(terminal, player, item, networkId, networkFirst) {
  let remainder = item.clone();

  if (networkFirst && networkId) {
    const result = addItemStack(networkId, remainder, "wireless_crafting_close");
    if (result.remaining <= 0) return { complete: true };
    remainder.amount = result.remaining;
  }

  if (player?.isValid) {
    const result = DoriosLib.player.giveItem(player, { item: remainder, dropRemainder: false });
    if (!result.remainder) return { complete: true };
    remainder = result.remainder;
  }

  try {
    const location = player?.isValid
      ? { x: player.location.x, y: player.location.y + 1, z: player.location.z }
      : terminal.entity.location;
    const dimension = player?.isValid ? player.dimension : terminal.dimension;
    dimension.spawnItem(remainder, location);
    return { complete: true };
  } catch {
    return { complete: false, remainder };
  }
}

function returnRemainingItems(terminal, player) {
  const container = terminal.container;
  if (!container) return true;

  const slots = terminal.getInterfaceConfig().slots;
  const burnSlots = new Set(slots.burn ?? []);
  const craftingSlots = new Set(slots.craftingGrid ?? []);
  const networkId = terminal.getLinkedNetworkId(terminal.entity);
  let complete = true;

  for (let slot = 0; slot < container.size; slot++) {
    let item = container.getItem(slot);
    if (!item) continue;

    if (terminal.isUiElementItem(item)) {
      container.setItem(slot, undefined);
      continue;
    }

    if (craftingSlots.has(slot) || burnSlots.has(slot)) {
      const materialized = materializeOutputItem(item, player);
      item = materialized.item ?? (!materialized.handled ? item : undefined);
      container.setItem(slot, item);
      if (!item) continue;
    } else if (readOutputToken(item)) {
      container.setItem(slot, undefined);
      continue;
    }

    const routed = routeRemainingItem(terminal, player, item, networkId, craftingSlots.has(slot));
    if (routed.complete) {
      container.setItem(slot, undefined);
    } else {
      container.setItem(slot, routed.remainder);
      complete = false;
    }
  }

  return complete;
}

function finalizeWirelessTerminal(entity, terminal) {
  terminal?.destroy();
  ButtonManager.unwatchEntity(entity);
  TickScheduler.releaseTickGroup(entity);
  try {
    entity.triggerEvent("despawn");
  } catch {
    try {
      entity.remove();
    } catch {}
  }
}

function removeWirelessTerminal(playerId, player, explicitEntity) {
  const cached = activePanels.get(playerId);
  const pending = pendingCleanupPanels.get(playerId);
  const entity = explicitEntity?.isValid
    ? explicitEntity
    : cached?.isValid
      ? cached
      : pending?.isValid
        ? pending
        : recoverWirelessTerminal(playerId, player?.dimension);
  activePanels.delete(playerId);
  if (!entity?.isValid) {
    pendingCleanupPanels.delete(playerId);
    return true;
  }

  DoriosLib.entity.stopPlayerTracking(entity);
  const terminal = getWirelessTerminal(entity);
  if (!terminal?.valid) {
    pendingCleanupPanels.set(playerId, entity);
    return false;
  }

  if (getEntityMode(entity) === CRAFTING_MODE) cancelCraftingRecipeResolution(entity);
  const networkId = terminal.getLinkedNetworkId(entity);
  if (networkId) terminal.processBurnSlots(entity, terminal.container, networkId);
  if (!returnRemainingItems(terminal, player)) {
    pendingCleanupPanels.set(playerId, entity);
    return false;
  }

  pendingCleanupPanels.delete(playerId);
  finalizeWirelessTerminal(entity, terminal);
  return true;
}

function updateWirelessPlayer(player) {
  const pending = pendingCleanupPanels.get(player.id);
  if (pending?.isValid && !removeWirelessTerminal(player.id, player, pending)) return;

  const heldItem = syncHeldPanelSlotLock(player);
  const profile = getPanelProfile(heldItem);
  if (!profile || heldItem.typeId !== profile.onId) {
    removeWirelessTerminal(player.id, player);
    lastStatusByPlayer.delete(player.id);
    return;
  }

  if (player.isSneaking ?? player.isSneak ?? false) {
    removeWirelessTerminal(player.id, player);
    lastStatusByPlayer.delete(player.id);
    return;
  }

  const centerKey = String(heldItem.getDynamicProperty(WIRELESS_CENTER_PROPERTY) ?? "");
  const network = getOnlineNetworkByCenter(centerKey);
  if (!network) {
    removeWirelessTerminal(player.id, player);
    showStatusOnce(player, "offline", "message.utilitycraft:wireless_network_unavailable");
    return;
  }

  const access = checkWirelessAccess(network, player.dimension.id, player.location);
  if (!access.allowed) {
    removeWirelessTerminal(player.id, player);
    if (access.reason === "dimension") {
      showStatusOnce(player, "dimension", "message.utilitycraft:wireless_dimension_unavailable");
    } else if (access.reason === "range") {
      showStatusOnce(player, "range", "message.utilitycraft:wireless_out_of_range");
    } else {
      showStatusOnce(player, "offline", "message.utilitycraft:wireless_network_unavailable");
    }
    return;
  }

  lastStatusByPlayer.delete(player.id);
  let entity = activePanels.get(player.id);
  if (!entity?.isValid) entity = recoverWirelessTerminal(player.id, player.dimension);
  if (entity?.isValid && getEntityMode(entity) !== profile.mode) {
    if (!removeWirelessTerminal(player.id, player, entity)) return;
    entity = undefined;
  }
  if (!entity?.isValid) {
    entity = spawnWirelessTerminal(player, centerKey, network.networkId, profile);
  }
  if (!entity?.isValid) return;

  activePanels.set(player.id, entity);
  entity.nameTag = profile.entityName;
  entity.setDynamicProperty(WIRELESS_CENTER_PROPERTY, centerKey);
  entity.setDynamicProperty(WIRELESS_MODE_PROPERTY, profile.mode);
  const terminal = getWirelessTerminal(entity, profile.mode);
  if (!terminal?.valid) {
    removeWirelessTerminal(player.id, player);
    return;
  }

  if (terminal.getLinkedNetworkId(entity) !== network.networkId) {
    terminal.linkNetwork(network.networkId);
  }
  terminal.tick();
}

world.beforeEvents.playerInteractWithEntity.subscribe(
  /** @param {any} event */ (event) => {
    if (event?.target?.typeId !== STORAGE_CENTER_ENTITY_TYPE) return;
    if (!getPanelProfile(event?.itemStack)) return;

    event.cancel = true;
    const lastTick = lastBindTickByPlayer.get(event.player.id) ?? -BIND_COOLDOWN_TICKS;
    if (system.currentTick - lastTick < BIND_COOLDOWN_TICKS) return;
    lastBindTickByPlayer.set(event.player.id, system.currentTick);

    const player = event.player;
    const center = event.target;
    system.run(() => bindHeldPanel(player, center));
  },
);

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  removeWirelessTerminal(playerId);
  lastStatusByPlayer.delete(playerId);
  lastBindTickByPlayer.delete(playerId);
  recoveryCheckedPlayers.delete(playerId);
  lockedPanelSlotByPlayer.delete(playerId);
  panelLockRecoveryCheckedPlayers.delete(playerId);
});

system.runInterval(() => {
  const players = world.getAllPlayers();
  for (const [playerId, entity] of pendingCleanupPanels) {
    const player = players.find((candidate) => candidate.id === playerId);
    try {
      removeWirelessTerminal(playerId, player, entity);
    } catch {}
  }

  for (const player of players) {
    try {
      updateWirelessPlayer(player);
    } catch {}
  }
}, UPDATE_INTERVAL_TICKS);
