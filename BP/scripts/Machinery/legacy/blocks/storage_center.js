import { ItemStack, system } from "@minecraft/server";
import { BasicMachine, EnergyStorage, Machine, TickScheduler } from "DoriosCore/index.js";
import {
  getEnergyAndFluidFromItem,
  spawnEntity,
  updateAdjacentNetwork,
} from "DoriosCore/utils/entity.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import { readNetworkMeta, readNetworkRecord, setNetworkPowerStateFromRecord } from "Machinery/storage/storage_db.js";

const ENERGY_SLOT = 0;
const INFO_SLOT = 1;
const NETWORK_BLOCK_COUNT_PROPERTY = "ucds_network_block_count";
const NETWORK_BASE_RATE_PROPERTY = "ucds_network_base_rate";
const NETWORK_RATE_PROPERTY = "ucds_network_rate";
const NETWORK_ID_PROPERTY = "ucds_network_id";
const NETWORK_IS_CORE_PROPERTY = "ucds_network_is_core";
const POWER_ONLINE_PROPERTY = "storage_center_power_online";
const DEFAULT_BASE_RATE = 10;
const DEFAULT_ENERGY_CAP = 512000;
const LABEL_REFRESH_TICKS = 100;

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

function getNetworkWarning(block, network, energyState) {
  if (!network) return "Disconnected";
  if (network.online) return "None";

  const core = getCoreTag(block);
  if (network.core && network.core !== core) return "Another Storage Center is core";
  if (!network.core) return "Core not registered";

  const storedEnergy = Math.max(0, Math.floor(Number(energyState?.energy ?? network.energy ?? 0)));
  if (storedEnergy <= 0) return "No energy";

  return "Network offline";
}

function getNetworkInfoLore(network) {
  if (!network) {
    return [
      " \u00A7r\u00A77- Network: \u00A7cDisconnected",
      " \u00A7r\u00A77- Stored: \u00A7f0 \u00A77/ \u00A7f0",
      " \u00A7r\u00A77- Usage: \u00A7f0.0%",
      " \u00A7r\u00A77- Warning: \u00A7cDisconnected",
    ];
  }

  const used = Math.max(0, Math.floor(Number(network.used) || 0));
  const capacity = Math.max(0, Math.floor(Number(network.capacity) || 0));
  const baseRate = Math.max(0, Math.floor(Number(network.baseRate) || 0));
  const warning = typeof network.warning === "string" ? network.warning : "None";
  const warningColor = warning === "None" ? "\u00A7a" : "\u00A7c";

  return [
    ` \u00A7r\u00A77- Network: ${network.online ? "\u00A7aOnline" : "\u00A7cOffline"}`,
    ` \u00A7r\u00A77- Rate: \u00A7f${formatStorageAmount(baseRate)} DE/t`,
    ` \u00A7r\u00A77- Stored: \u00A7f${formatStorageAmount(used)} \u00A77/ \u00A7f${formatStorageAmount(capacity)}`,
    ` \u00A7r\u00A77- Usage: \u00A7f${formatUsagePercent(used, capacity)}`,
    ` \u00A7r\u00A77- Warning: ${warningColor}${warning}`,
  ];
}

function setInfoItem(inv, entity, network) {
  const state = network
    ? [
      network.version ?? 0,
      network.online ? 1 : 0,
      network.baseRate ?? 0,
      network.rate ?? 0,
      network.used ?? 0,
      network.capacity ?? 0,
      network.warning ?? "",
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
  const rate = baseRate * Math.max(1, Math.floor(Number(TickScheduler.getProcessingInterval(entity)) || 1));
  entity.setDynamicProperty(NETWORK_BASE_RATE_PROPERTY, baseRate);
  entity.setDynamicProperty(NETWORK_RATE_PROPERTY, rate);
  return { blockCount, baseRate, rate };
}

function getCachedNetworkId(block, entity) {
  const cached = entity.getDynamicProperty(NETWORK_ID_PROPERTY);
  return Number.isInteger(cached) && cached > 0 ? cached : getNetworkIdForBlock(block);
}

function readCachedNetworkMeta(block, entity) {
  return readNetworkMeta(getCachedNetworkId(block, entity));
}

function isNetworkCore(entity) {
  const value = entity.getDynamicProperty(NETWORK_IS_CORE_PROPERTY);
  return typeof value === "boolean" ? value : true;
}

function updateEnergyState(machine, settings, consumeEnergy = false) {
  const { entity, energy } = machine;
  energy.setCap(settings?.machine?.energy_cap ?? DEFAULT_ENERGY_CAP);
  const { blockCount, baseRate } = getNetworkRates(entity, settings);
  machine.setRate(baseRate);
  const rate = machine.rate;
  if (consumeEnergy && rate > 0) {
    const available = energy.get();
    const consumed = Math.min(available, rate);
    if (consumed > 0) energy.consume(consumed);
  }
  const stored = energy.get();
  const cap = energy.getCap();
  machine.displayEnergy(ENERGY_SLOT);

  return {
    blockCount,
    baseRate,
    rate,
    energy: stored,
    energyCap: cap,
    online: stored > 0,
  };
}

function publishNetworkPowerState(block, entity, energyState, currentNetwork = undefined) {
  const networkId = getCachedNetworkId(block, entity);
  const network = currentNetwork ?? readNetworkRecord(networkId);
  if (!network) return undefined;

  const core = getCoreTag(block);
  if (network.core && network.core !== core) {
    entity.setDynamicProperty(NETWORK_IS_CORE_PROPERTY, false);
    entity.setDynamicProperty(POWER_ONLINE_PROPERTY, network.online === true);
    return {
      ...network,
      warning: getNetworkWarning(block, network, energyState),
      blockCount: energyState.blockCount,
      baseRate: energyState.baseRate,
      rate: energyState.rate,
      energy: energyState.energy,
      energyCap: energyState.energyCap,
    };
  }

  const nextNetwork = setNetworkPowerStateFromRecord(networkId, network, energyState.online, {
    core,
    baseRate: energyState.baseRate,
    rate: energyState.rate,
    energy: energyState.energy,
    energyCap: energyState.energyCap,
  }) ?? network;

  entity.setDynamicProperty(POWER_ONLINE_PROPERTY, nextNetwork.online === true);

  return {
    ...nextNetwork,
    blockCount: energyState.blockCount,
    baseRate: energyState.baseRate,
    rate: energyState.rate,
    energy: energyState.energy,
    energyCap: energyState.energyCap,
    warning: getNetworkWarning(block, nextNetwork, energyState),
  };
}

function readNetworkInfo(block, entity, energyState) {
  const networkId = getCachedNetworkId(block, entity);
  const network = readNetworkRecord(networkId);
  if (!network) return undefined;
  if (!network.core && isNetworkCore(entity)) {
    return publishNetworkPowerState(block, entity, energyState, network);
  }

  return {
    ...network,
    blockCount: energyState.blockCount,
    baseRate: energyState.baseRate,
    rate: energyState.rate,
    energy: energyState.energy,
    energyCap: energyState.energyCap,
    warning: getNetworkWarning(block, network, energyState),
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
      entity.setDynamicProperty(NETWORK_RATE_PROPERTY, (settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE) * Math.max(1, Math.floor(Number(TickScheduler.getProcessingInterval(entity)) || 1)));

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
        const energy = new EnergyStorage(entity);
        energy.setCap(settings?.machine?.energy_cap ?? DEFAULT_ENERGY_CAP);
        const energyState = {
          blockCount: getNetworkBlockCount(entity),
          baseRate: Math.max(0, Math.floor(Number(entity.getDynamicProperty(NETWORK_BASE_RATE_PROPERTY) ?? settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE))),
          rate: Math.max(0, Math.floor(Number(entity.getDynamicProperty(NETWORK_RATE_PROPERTY) ?? (settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE) * Math.max(1, Math.floor(Number(TickScheduler.getProcessingInterval(entity)) || 1))))),
          energy: energy.get(),
          energyCap: energy.getCap(),
          online: energy.get() > 0,
        };
        energy.display(ENERGY_SLOT);
        const network = publishNetworkPowerState(block, entity, energyState);
        if (inv) setInfoItem(inv, entity, network);
      }, 4);
    });
  },

  onTick({ block }, { params: settings }) {
    const machine = new BasicMachine(block, settings?.machine?.rate_speed_base ?? DEFAULT_BASE_RATE);
    if (!machine.valid) return;

    const { entity, container: inv } = machine;

    const activeCore = isNetworkCore(entity);
    const energyState = updateEnergyState(machine, settings, activeCore);
    const previousOnline = entity.getDynamicProperty(POWER_ONLINE_PROPERTY);
    const networkMeta = activeCore ? readCachedNetworkMeta(block, entity) : undefined;
    let network;

    if (
      activeCore &&
      (
        previousOnline !== energyState.online ||
        (networkMeta && networkMeta.online !== energyState.online)
      )
    ) {
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
