import { ItemLockMode, ItemStack, system, world } from "@minecraft/server";
import { ButtonManager, TickScheduler } from "DoriosCore/index.js";
import * as DoriosLib from "DoriosLib/index.js";
import { StorageTerminalInterface, STORAGE_TERMINAL_CONFIG } from "../../interface/terminal.js";
import { materializeOutputItem, readOutputToken } from "../../interface/terminal_output.js";
import { getOnlineNetworkByCenter } from "../network_runtime.js";
import { checkWirelessAccess } from "../wireless_access.js";

const DIMENSION_IDS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const STORAGE_CENTER_ENTITY_TYPE = "utilitycraft:storage_center";
const WIRELESS_PANEL_OFF = "utilitycraft:wireless_panel_off";
const WIRELESS_PANEL_ON = "utilitycraft:wireless_panel_on";
const WIRELESS_TERMINAL_ENTITY_TYPE = "utilitycraft:wireless_storage_terminal";
const WIRELESS_CENTER_PROPERTY = "ucds:wireless_center";
const WIRELESS_MACHINE_ID = "wireless_storage_terminal";
const UPDATE_INTERVAL_TICKS = 1;
const BIND_COOLDOWN_TICKS = 5;

const TRACKING_OPTIONS = Object.freeze({
  anchor: "head",
  viewOffset: 0.5,
  velocityFactor: 5,
  offset: Object.freeze({ x: 0, y: -0.5, z: 0 }),
});

const WIRELESS_TERMINAL_CONFIG = {
  ...STORAGE_TERMINAL_CONFIG,
  machineId: WIRELESS_MACHINE_ID,
  entityType: WIRELESS_TERMINAL_ENTITY_TYPE,
};

const activePanels = new Map();
const lastStatusByPlayer = new Map();
const lastBindTickByPlayer = new Map();
const recoveryCheckedPlayers = new Set();
const lockedPanelSlotByPlayer = new Map();
const panelLockRecoveryCheckedPlayers = new Set();

class WirelessStorageTerminalInterface extends StorageTerminalInterface {
  static get config() {
    return WIRELESS_TERMINAL_CONFIG;
  }
}

WirelessStorageTerminalInterface.registerButtons();

function getWirelessTerminal(entity) {
  const block = WirelessStorageTerminalInterface.getBlock(entity);
  return block ? new WirelessStorageTerminalInterface(block) : undefined;
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
  if (item?.typeId !== WIRELESS_PANEL_ON) return item;
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
    if (item?.typeId !== WIRELESS_PANEL_ON || item.lockMode !== ItemLockMode.slot) continue;
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
  if (heldItem?.typeId !== WIRELESS_PANEL_ON) {
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
  if (!heldItem || (heldItem.typeId !== WIRELESS_PANEL_OFF && heldItem.typeId !== WIRELESS_PANEL_ON)) return false;

  const linkedItem = heldItem.typeId === WIRELESS_PANEL_ON
    ? heldItem
    : new ItemStack(WIRELESS_PANEL_ON, 1);
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

function spawnWirelessTerminal(player, centerKey, networkId) {
  let entity = recoverWirelessTerminal(player.id, player.dimension);
  const isNew = !entity?.isValid;
  try {
    if (isNew) {
      entity = player.dimension.spawnEntity(WIRELESS_TERMINAL_ENTITY_TYPE, player.location);
      entity.addTag(player.id);
    }

    entity.nameTag = "entity.utilitycraft:storage_terminal.name";
    entity.setDynamicProperty(WIRELESS_CENTER_PROPERTY, centerKey);
    const tameable = entity.getComponent("minecraft:tameable");
    if (!tameable || (
      tameable.tamedToPlayerId !== player.id
      && tameable.tame(player) !== true
      && tameable.tamedToPlayerId !== player.id
    )) {
      entity.remove();
      return undefined;
    }

    const terminal = getWirelessTerminal(entity);
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

function returnRemainingItems(terminal, player) {
  const container = terminal.container;
  if (!container) return;

  const burnSlots = new Set(terminal.getInterfaceConfig().slots.burn ?? []);
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;

    if (burnSlots.has(slot)) {
      const materialized = materializeOutputItem(item, player);
      const realItem = materialized.item ?? (!materialized.handled ? item : undefined);
      if (realItem) {
        if (player?.isValid) DoriosLib.player.giveItem(player, { item: realItem });
        else terminal.dimension.spawnItem(realItem, terminal.entity.location);
      }
    } else if (!terminal.isUiElementItem(item) && !readOutputToken(item)) {
      if (player?.isValid) DoriosLib.player.giveItem(player, { item });
      else terminal.dimension.spawnItem(item, terminal.entity.location);
    }

    container.setItem(slot, undefined);
  }
}

function removeWirelessTerminal(playerId, player) {
  const cached = activePanels.get(playerId);
  const entity = cached?.isValid ? cached : recoverWirelessTerminal(playerId, player?.dimension);
  activePanels.delete(playerId);
  if (!entity?.isValid) return;

  DoriosLib.entity.stopPlayerTracking(entity);
  const terminal = getWirelessTerminal(entity);
  if (terminal?.valid) {
    const networkId = terminal.getLinkedNetworkId(entity);
    if (networkId) terminal.processBurnSlots(entity, terminal.container, networkId);
    returnRemainingItems(terminal, player);
    terminal.destroy();
  }

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

function updateWirelessPlayer(player) {
  const heldItem = syncHeldPanelSlotLock(player);
  if (heldItem?.typeId !== WIRELESS_PANEL_ON) {
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
  if (!entity?.isValid) {
    entity = spawnWirelessTerminal(player, centerKey, network.networkId);
  }
  if (!entity?.isValid) return;

  entity.setDynamicProperty(WIRELESS_CENTER_PROPERTY, centerKey);
  const terminal = getWirelessTerminal(entity);
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
    if (event?.itemStack?.typeId !== WIRELESS_PANEL_OFF && event?.itemStack?.typeId !== WIRELESS_PANEL_ON) return;

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
  for (const player of world.getAllPlayers()) {
    try {
      updateWirelessPlayer(player);
    } catch {}
  }
}, UPDATE_INTERVAL_TICKS);
