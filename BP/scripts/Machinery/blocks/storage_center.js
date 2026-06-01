import { ItemStack, system } from "@minecraft/server";
import { EnergyStorage, Machine } from "DoriosCore/index.js";
import {
  getEnergyAndFluidFromItem,
  shouldProcess,
  spawnEntity,
  updateAdjacentNetwork,
} from "DoriosCore/utils/entity.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import { readNetworkRecord, setNetworkPowerStateFromRecord } from "Machinery/storage/storage_db.js";

const ENERGY_SLOT = 0;
const INFO_SLOT = 1;
const DISK_SLOTS = 9;
const NETWORK_BLOCK_COUNT_PROPERTY = "ucds_network_block_count";
const NETWORK_BASE_RATE_PROPERTY = "ucds_network_base_rate";
const NETWORK_RATE_PROPERTY = "ucds_network_rate";
const NETWORK_ID_PROPERTY = "ucds_network_id";
const NETWORK_IS_CORE_PROPERTY = "ucds_network_is_core";
const POWER_ONLINE_PROPERTY = "storage_center_power_online";
const DEFAULT_BASE_RATE = 10;
const DEFAULT_ENERGY_CAP = 512000;
const LABEL_REFRESH_TICKS = 100;

function getStorageCenterEntity(block) {
  return block.dimension
    .getEntitiesAtBlockLocation(block.location)
    .find((entity) => entity.typeId === "utilitycraft:storage_center");
}

function formatStorageAmount(value) {
  const amount = Math.max(0, Math.floor(Number(value) || 0));
  if (amount >= 1000000000) return `${(amount / 1000000000).toFixed(1)}B`;
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return amount.toString();
}

function formatUsagePercent(used, capacity) {
  const max = Math.max(0, Number(capacity) || 0);
  if (max <= 0) return "0.0%";
  const percent = Math.max(0, Math.min(100, ((Number(used) || 0) / max) * 100));
  return `${percent.toFixed(1)}%`;
}

function getCoreTag(block) {
  const { x, y, z } = block.location;
  return `${block.dimension.id}|[${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}]`;
}

function getNetworkInfoLore(network) {
  if (!network) {
    return [
      " \u00A7r\u00A77- Network: \u00A7cDisconnected",
      " \u00A7r\u00A77- Stored: \u00A7f0 \u00A77/ \u00A7f0",
      " \u00A7r\u00A77- Usage: \u00A7f0.0%",
      " \u00A7r\u00A77- Disks: \u00A7f0/0",
      " \u00A7r\u00A77- Blocks: \u00A7f0",
      " \u00A7r\u00A77- Item Types: \u00A7f0",
    ];
  }

  const used = Math.max(0, Math.floor(Number(network.used) || 0));
  const capacity = Math.max(0, Math.floor(Number(network.capacity) || 0));
  const drives = Array.isArray(network.drives) ? network.drives.length : 0;
  const cells = Array.isArray(network.cells) ? network.cells.length : 0;
  const maxCells = drives * DISK_SLOTS;
  const itemTypes = Math.max(0, Math.floor(Number(network.itemTypes ?? 0)));
  const blockCount = Math.max(0, Math.floor(Number(network.blockCount) || 0));
  const baseRate = Math.max(0, Math.floor(Number(network.baseRate) || 0));

  return [
    ` \u00A7r\u00A77- Network: ${network.online ? "\u00A7aOnline" : "\u00A7cOffline"}`,
    ` \u00A7r\u00A77- Rate: \u00A7f${formatStorageAmount(baseRate)} DE/t`,
    ` \u00A7r\u00A77- Stored: \u00A7f${formatStorageAmount(used)} \u00A77/ \u00A7f${formatStorageAmount(capacity)}`,
    ` \u00A7r\u00A77- Usage: \u00A7f${formatUsagePercent(used, capacity)}`,
    ` \u00A7r\u00A77- Disks: \u00A7f${cells}/${maxCells}`,
    ` \u00A7r\u00A77- Blocks: \u00A7f${blockCount}`,
    ` \u00A7r\u00A77- Item Types: \u00A7f${itemTypes}`,
  ];
}

function setInfoItem(inv, entity, network) {
  const state = network
    ? [
      network.version ?? 0,
      network.online ? 1 : 0,
      network.baseRate ?? 0,
      network.rate ?? 0,
      network.blockCount ?? 0,
      network.used ?? 0,
      network.capacity ?? 0,
      (network.cells ?? []).length,
      (network.drives ?? []).length,
      network.itemTypes ?? 0,
    ].join("|")
    : "disconnected";

  if (entity.getDynamicProperty("storage_center_info_state") === state) return;
  entity.setDynamicProperty("storage_center_info_state", state);

  const label = new ItemStack("utilitycraft:ui_filler", 1);
  label.nameTag = "\n\u00A7r\u00A7bNetwork Info:";
  label.setLore(getNetworkInfoLore(network));
  inv.setItem(INFO_SLOT, label);
}

function shouldRefreshInfoLabel(entity, force = false) {
  if (force) return true;

  const currentTick = system.currentTick ?? 0;
  const lastTick = Math.floor(Number(entity.getDynamicProperty("storage_center_info_tick") ?? -LABEL_REFRESH_TICKS));
  if (currentTick - lastTick < LABEL_REFRESH_TICKS) return false;

  entity.setDynamicProperty("storage_center_info_tick", currentTick);
  return true;
}

function getNetworkBlockCount(entity) {
  return Math.max(0, Math.floor(Number(entity.getDynamicProperty(NETWORK_BLOCK_COUNT_PROPERTY) ?? 0)));
}

function getNetworkRates(entity, settings) {
  const blockCount = getNetworkBlockCount(entity);
  const baseRate = Math.max(0, Math.floor(Number(
    entity.getDynamicProperty(NETWORK_BASE_RATE_PROPERTY) ?? settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE,
  )));
  const rate = baseRate * Math.max(1, Math.floor(Number(globalThis.tickSpeed ?? 1)));
  entity.setDynamicProperty(NETWORK_BASE_RATE_PROPERTY, baseRate);
  entity.setDynamicProperty(NETWORK_RATE_PROPERTY, rate);
  return { blockCount, baseRate, rate };
}

function getCachedNetworkId(block, entity) {
  const cached = entity.getDynamicProperty(NETWORK_ID_PROPERTY);
  return Number.isInteger(cached) && cached > 0 ? cached : getNetworkIdForBlock(block);
}

function isNetworkCore(entity) {
  const value = entity.getDynamicProperty(NETWORK_IS_CORE_PROPERTY);
  return typeof value === "boolean" ? value : true;
}

function updateEnergyState(entity, settings, consumeEnergy = false) {
  const energy = new EnergyStorage(entity);
  energy.setCap(settings?.machine?.energy_cap ?? DEFAULT_ENERGY_CAP);
  const { blockCount, baseRate, rate } = getNetworkRates(entity, settings);
  if (consumeEnergy && rate > 0) {
    const available = energy.get();
    const consumed = Math.min(available, rate);
    if (consumed > 0) energy.consume(consumed);
  }
  const stored = energy.get();
  const cap = energy.getCap();
  energy.display(ENERGY_SLOT);

  return {
    blockCount,
    baseRate,
    rate,
    energy: stored,
    energyCap: cap,
    online: stored > 0,
  };
}

function publishNetworkPowerState(block, entity, energyState) {
  const networkId = getCachedNetworkId(block, entity);
  const network = readNetworkRecord(networkId);
  if (!network) return undefined;

  const core = getCoreTag(block);
  if (network.core && network.core !== core) {
    entity.setDynamicProperty(NETWORK_IS_CORE_PROPERTY, false);
    entity.setDynamicProperty(POWER_ONLINE_PROPERTY, network.online === true);
    return network;
  }

  const wasOnline = network.online === true;
  const nextNetwork = setNetworkPowerStateFromRecord(networkId, network, energyState.online, {
    core,
    baseRate: energyState.baseRate,
    rate: energyState.rate,
    energy: energyState.energy,
    energyCap: energyState.energyCap,
  }) ?? network;

  entity.setDynamicProperty(POWER_ONLINE_PROPERTY, nextNetwork.online === true);
  if (wasOnline !== nextNetwork.online) {
    updateNetworkAround(block);
  }

  return {
    ...nextNetwork,
    itemTypes: Object.keys(nextNetwork.totals ?? {}).length,
    blockCount: energyState.blockCount,
    baseRate: energyState.baseRate,
    rate: energyState.rate,
    energy: energyState.energy,
    energyCap: energyState.energyCap,
  };
}

function readNetworkInfo(block, entity, energyState) {
  const networkId = getCachedNetworkId(block, entity);
  const network = readNetworkRecord(networkId);
  if (!network) return undefined;
  const itemTypes = Object.keys(network.totals ?? {}).length;

  return {
    ...network,
    itemTypes,
    blockCount: energyState.blockCount,
    baseRate: energyState.baseRate,
    rate: energyState.rate,
    energy: energyState.energy,
    energyCap: energyState.energyCap,
  };
}

DoriosAPI.register.blockComponent("storage_center", {
  beforeOnPlayerPlace(e, { params: settings }) {
    const { block, player } = e;
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: "utilitycraft:storage_center",
          name: "storage_center",
          inventory_size: settings?.entity?.inventory_size ?? 2,
          input_range: settings?.entity?.input_range ?? [-1, -1],
          output_range: settings?.entity?.output_range ?? [-1, -1],
        },
      });
      entity.triggerEvent("utilitycraft:setup_inventory");
      entity.nameTag = "entity.utilitycraft:storage_center.name";
      entity.setDynamicProperty("storage_center_info_state", "");
      entity.setDynamicProperty("storage_center_info_tick", 0);
      entity.setDynamicProperty(POWER_ONLINE_PROPERTY, false);
      entity.setDynamicProperty(NETWORK_BLOCK_COUNT_PROPERTY, 1);
      entity.setDynamicProperty(NETWORK_BASE_RATE_PROPERTY, settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE);
      entity.setDynamicProperty(NETWORK_RATE_PROPERTY, (settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE) * Math.max(1, Math.floor(Number(globalThis.tickSpeed ?? 1))));

      const mainHand = player?.getComponent("equippable")?.getEquipment("Mainhand");
      const { energy: storedEnergy } = getEnergyAndFluidFromItem(mainHand);
      const energy = new EnergyStorage(entity);
      energy.setCap(settings?.machine?.energy_cap ?? DEFAULT_ENERGY_CAP);
      energy.set(storedEnergy ?? 0);
      energy.display(ENERGY_SLOT);

      const inv = entity.getComponent("minecraft:inventory")?.container;
      if (inv) setInfoItem(inv, entity, undefined);

      updateNetworkAround(block);
      updateAdjacentNetwork(block);
      system.runTimeout(() => {
        const energyState = updateEnergyState(entity, settings);
        const network = publishNetworkPowerState(block, entity, energyState);
        if (inv) setInfoItem(inv, entity, network);
      }, 4);
    });
  },

  onTick({ block }, { params: settings }) {
    const entity = getStorageCenterEntity(block);
    if (!entity || !entity.isValid) return;

    const inv = entity.getComponent("minecraft:inventory")?.container;
    if (!inv) return;

    const activeCore = isNetworkCore(entity);
    const energyState = updateEnergyState(entity, settings, activeCore && shouldProcess());
    const previousOnline = entity.getDynamicProperty(POWER_ONLINE_PROPERTY);
    let network;

    if (activeCore && previousOnline !== energyState.online) {
      network = publishNetworkPowerState(block, entity, energyState);
    }

    if (shouldRefreshInfoLabel(entity)) {
      network = network ?? readNetworkInfo(block, entity, energyState);
      setInfoItem(inv, entity, network);
    }
  },

  onPlayerBreak(e) {
    updateNetworkAround(e.block);
    updateAdjacentNetwork(e.block, e.brokenBlockPermutation);
    Machine.onDestroy(e);
  },
});
