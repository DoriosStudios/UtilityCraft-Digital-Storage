import { ItemStack, system } from "@minecraft/server";
import { Machine } from "DoriosCore/index.js";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import {
  getNetworkIdForBlock,
  updateNetworkAround,
} from "Machinery/storage/network_manager.js";
import { readNetworkRecord } from "Machinery/storage/storage_db.js";

const INFO_SLOT = 0;
const DISK_SLOTS = 9;

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

function getNetworkInfoLore(network) {
  if (!network) {
    return [
      " \u00A7r\u00A77- Network: \u00A7cDisconnected",
      " \u00A7r\u00A77- Stored: \u00A7f0 \u00A77/ \u00A7f0",
      " \u00A7r\u00A77- Usage: \u00A7f0.0%",
      " \u00A7r\u00A77- Free: \u00A7f0",
      " \u00A7r\u00A77- Disks: \u00A7f0/0",
      " \u00A7r\u00A77- Item Types: \u00A7f0",
    ];
  }

  const used = Math.max(0, Math.floor(Number(network.used) || 0));
  const capacity = Math.max(0, Math.floor(Number(network.capacity) || 0));
  const free = Math.max(0, capacity - used);
  const drives = Array.isArray(network.drives) ? network.drives.length : 0;
  const cells = Array.isArray(network.cells) ? network.cells.length : 0;
  const maxCells = drives * DISK_SLOTS;
  const itemTypes = Object.keys(network.totals ?? {}).filter((key) => (network.totals[key] || 0) > 0).length;

  return [
    " \u00A7r\u00A77- Network: \u00A7aOnline",
    ` \u00A7r\u00A77- Stored: \u00A7f${formatStorageAmount(used)} \u00A77/ \u00A7f${formatStorageAmount(capacity)}`,
    ` \u00A7r\u00A77- Usage: \u00A7f${formatUsagePercent(used, capacity)}`,
    ` \u00A7r\u00A77- Free: \u00A7f${formatStorageAmount(free)}`,
    ` \u00A7r\u00A77- Disks: \u00A7f${cells}/${maxCells}`,
    ` \u00A7r\u00A77- Disk Drives: \u00A7f${drives}`,
    ` \u00A7r\u00A77- Item Types: \u00A7f${itemTypes}`,
  ];
}

function setInfoItem(inv, entity, network) {
  const state = network
    ? [
      network.version ?? 0,
      network.used ?? 0,
      network.capacity ?? 0,
      (network.cells ?? []).length,
      (network.drives ?? []).length,
      Object.keys(network.totals ?? {}).length,
    ].join("|")
    : "disconnected";

  if (entity.getDynamicProperty("storage_center_info_state") === state) return;
  entity.setDynamicProperty("storage_center_info_state", state);

  const label = new ItemStack("utilitycraft:ui_filler", 1);
  label.nameTag = "\n\u00A7r\u00A7bNetwork Info:";
  label.setLore(getNetworkInfoLore(network));
  inv.setItem(INFO_SLOT, label);
}

DoriosAPI.register.blockComponent("storage_center", {
  beforeOnPlayerPlace(e, { params: settings }) {
    const { block } = e;
    system.run(() => {
      const entity = spawnEntity(block, {
        entity: {
          identifier: "utilitycraft:storage_center",
          name: "storage_center",
          inventory_size: settings?.entity?.inventory_size ?? 1,
          input_range: settings?.entity?.input_range ?? [-1, -1],
          output_range: settings?.entity?.output_range ?? [-1, -1],
        },
      });
      entity.triggerEvent("utilitycraft:setup_inventory");
      entity.nameTag = "entity.utilitycraft:storage_center.name";
      entity.setDynamicProperty("storage_center_info_state", "");

      const inv = entity.getComponent("minecraft:inventory")?.container;
      if (inv) setInfoItem(inv, entity, undefined);

      updateNetworkAround(block);
    });
  },

  onTick({ block }) {
    const entity = getStorageCenterEntity(block);
    if (!entity || !entity.isValid) return;

    const inv = entity.getComponent("minecraft:inventory")?.container;
    if (!inv) return;

    const networkId = getNetworkIdForBlock(block);
    const network = readNetworkRecord(networkId);
    setInfoItem(inv, entity, network);
  },

  onPlayerBreak(e) {
    updateNetworkAround(e.block);
    Machine.onDestroy(e);
  },
});
