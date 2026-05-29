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
export function saveCellData(container, slot, cellItem, dataObj) {
  const saved = writeCellData(cellItem, dataObj);
  const newTotal = saved?.totalItems ?? 0;
  const capacity = saved?.capacity ?? dataObj.capacity;
  cellItem.setLore([`\u00A7r\u00A77- Storage: \u00A7f${newTotal} / ${capacity}`]);
  container.setItem(slot, cellItem);
  try {
    const entity = container?.entity;
    if (entity) entity.setDynamicProperty("disk_info_state", "");
  } catch {}
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
        label.nameTag = "\n§r§bDisk Info:";
        label.setLore([
          ` §r§7- Cells: §f0/9`,
          ` §r§7- Usage:`,
          ` §r§7 - §f0`,
          ` §r§7 - §f0`,
        ]);
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
        if (!previousCellId && data.cellId) inv.setItem(i, cell);
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
    label.nameTag = "\n§r§bDisk Info:";
    label.setLore([
      ` §r§7- Cells: §f${cells}/9`,
      ` §r§7- Usage:`,
      ` §r§7 - §f${totalStored}`,
      ` §r§7 - §f${totalCap}`,
    ]);
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
