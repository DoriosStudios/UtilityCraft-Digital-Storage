import { ItemStack, system } from "@minecraft/server";
import { Machine, Rotation } from "DoriosCore/index.js";
import {
  CELL_CAPACITIES,
  getCellId,
  readCellData,
  writeCellData,
} from "Machinery/storage/storage_db.js";
import { updateNetworkAround } from "Machinery/storage/network_manager.js";

const INFO_SLOT = 0;
const CELL_START = 1;
const CELL_END = 9;

export const cellCapacities = {
  ...CELL_CAPACITIES,
};
export function getCellData(cellItem) {
  return readCellData(cellItem) ?? null;
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

function getCellLore(data) {
  const used = data?.totalItems ?? data?.used ?? 0;
  const capacity = data?.capacity ?? 0;
  const free = Math.max(0, capacity - used);
  return [
    `\u00A7r\u00A77- Stored: \u00A7f${formatStorageAmount(used)}`,
    `\u00A7r\u00A77- Usage: \u00A7f${formatUsagePercent(used, capacity)}`,
    `\u00A7r\u00A77- Free: \u00A7f${formatStorageAmount(free)}`,
  ];
}

function getDiskInfoLore(cells, used, capacity) {
  const free = Math.max(0, capacity - used);
  return [
    ` \u00A7r\u00A77- Cells: \u00A7f${cells}/9`,
    ` \u00A7r\u00A77- Stored: \u00A7f${formatStorageAmount(used)} \u00A77/ \u00A7f${formatStorageAmount(capacity)}`,
    ` \u00A7r\u00A77- Usage: \u00A7f${formatUsagePercent(used, capacity)}%`,
    ` \u00A7r\u00A77- Free: \u00A7f${formatStorageAmount(free)}`,
  ];
}

function cellLoreMatches(cellItem, data) {
  const currentLore = cellItem.getLore() ?? [];
  const expectedLore = getCellLore(data);
  return (
    currentLore.length === expectedLore.length &&
    currentLore.every((line, index) => line === expectedLore[index])
  );
}

function syncCellLore(container, slot, cellItem, data) {
  if (!cellItem || !data || cellLoreMatches(cellItem, data)) return false;
  cellItem.setLore(getCellLore(data));
  container.setItem(slot, cellItem);
  return true;
}

export function saveCellData(container, slot, cellItem, dataObj) {
  const saved = writeCellData(cellItem, dataObj);
  syncCellLore(container, slot, cellItem, saved ?? dataObj);
  try {
    const entity = container?.entity;
    if (entity) entity.setDynamicProperty("disk_info_state", "");
  } catch { }
}

DoriosAPI.register.blockComponent("disk_drive", {
  beforeOnPlayerPlace(e, { params: settings }) {
    const { block, player, permutationToPlace } = e;
    if (settings?.rotation) {
      if (player.isInSurvival()) {
        system.run(() =>
          player.runCommand(`clear @s ${permutationToPlace.type.id} 0 1`),
        );
      }
      e.cancel = true;
      Rotation.facing(player, block, permutationToPlace);
    }
    system.run(() => {
      const { x, y, z } = block.center();
      const entity = block.dimension.spawnEntity("utilitycraft:disk_drive", {
        x,
        y: y - 0.5,
        z,
      });
      entity.nameTag = "entity.utilitycraft:disk_drive.name";
      system.runTimeout(() => {
        const inv = entity.getComponent("minecraft:inventory")?.container;
        if (!inv) return;
        let label = new ItemStack("utilitycraft:ui_filler", 1);
        label.nameTag = "\n\u00A7r\u00A7bDisk Info:";
        label.setLore(getDiskInfoLore(0, 0, 0));
        inv.setItem(INFO_SLOT, label);
        entity.setDynamicProperty("disk_info_state", "");
        entity.setDynamicProperty("disk_cell_state", "");
        updateNetworkAround(block);
      }, 1);
    });
  },
  onTick(e) {
    const { block } = e;
    const entity = block.dimension
      .getEntitiesAtBlockLocation(block.location)
      .find((ent) => ent.typeId === "utilitycraft:disk_drive");
    if (!entity) return;
    const inv = entity.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    let totalStored = 0;
    let totalCap = 0;
    let cells = 0;
    const cellTopology = [];
    for (let i = CELL_START; i <= CELL_END; i++) {
      const cell = inv.getItem(i);
      const previousCellId = getCellId(cell);
      let data = cell ? readCellData(cell, true) : undefined;
      if (data) {
        const loreUpdated = syncCellLore(inv, i, cell, data);
        if (!previousCellId && data.cellId && !loreUpdated) inv.setItem(i, cell);
        cells++;
        totalStored += data.totalItems;
        totalCap += data.capacity;
        cellTopology.push(`${i}:${cell.typeId}:${data.cellId ?? "new"}:${data.capacity}`);
      }
    }
    const infoState = `${cells}|${totalStored}|${totalCap}`;
    const topologyState = cellTopology.join(",");
    const lastInfoState = entity.getDynamicProperty("disk_info_state");
    const lastTopologyState = entity.getDynamicProperty("disk_cell_state");
    if (infoState !== lastInfoState) {
      entity.setDynamicProperty("disk_info_state", infoState);
      let label = new ItemStack("utilitycraft:ui_filler", 1);
      label.nameTag = "\n\u00A7r\u00A7bDisk Info:";
      label.setLore(getDiskInfoLore(cells, totalStored, totalCap));
      inv.setItem(INFO_SLOT, label);
    }

    if (topologyState !== lastTopologyState) {
      entity.setDynamicProperty("disk_cell_state", topologyState);
      updateNetworkAround(block);
    }
  },
  onPlayerBreak(e) {
    updateNetworkAround(e.block);
    Machine.onDestroy(e);
  },
});
