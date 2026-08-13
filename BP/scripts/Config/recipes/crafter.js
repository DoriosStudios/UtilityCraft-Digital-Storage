import * as DoriosLib from "DoriosLib/index.js";
import { system } from "@minecraft/server";

/**
 * Recipes received from UtilityCraft's Crafter registry.
 *
 * Digital Storage does not write its recipes into this table directly. Every
 * recipe tagged `utilitycraft_workbench` is queued through DoriosLib below and
 * arrives through the same ScriptEvent used by UtilityCraft and other addons.
 *
 * @type {Record<string, {output:string, amount?:number, leftover?:string[]}>}
 */
export const crafterRecipes = {};

const digitalStorageCrafterRecipes = {
  "cell_casing,advanced_storage_part,air,air,air,air,air,air,air": {
    output: "utilitycraft:advanced_storage_cell",
    amount: 1,
  },
  "tinted_glass,basic_storage_part,tinted_glass,basic_storage_part,storage_core,basic_storage_part,glowstone_dust,advanced_chip,glowstone_dust": {
    output: "utilitycraft:advanced_storage_part",
    amount: 1,
  },
  "cell_casing,basic_storage_part,air,air,air,air,air,air,air": {
    output: "utilitycraft:basic_storage_cell",
    amount: 1,
  },
  "tinted_glass,storage_part,tinted_glass,storage_part,storage_core,storage_part,glowstone_dust,basic_chip,glowstone_dust": {
    output: "utilitycraft:basic_storage_part",
    amount: 1,
  },
  "steel_ingot,tinted_glass,steel_ingot,tinted_glass,air,tinted_glass,steel_ingot,fluxite,steel_ingot": {
    output: "utilitycraft:cell_casing",
    amount: 1,
  },
  "redstone,crafter,redstone,gold_dust,storage_terminal,gold_dust,redstone,fluxite,redstone": {
    output: "utilitycraft:crafting_terminal",
    amount: 1,
  },
  "cell_casing,expert_storage_part,air,air,air,air,air,air,air": {
    output: "utilitycraft:expert_storage_cell",
    amount: 1,
  },
  "tinted_glass,advanced_storage_part,tinted_glass,advanced_storage_part,storage_core,advanced_storage_part,glowstone_dust,expert_chip,glowstone_dust": {
    output: "utilitycraft:expert_storage_part",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_exporter,iron_ingot": {
    output: "utilitycraft:export_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_exporter_blue,iron_ingot": {
    output: "utilitycraft:export_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_exporter_purple,iron_ingot": {
    output: "utilitycraft:export_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_exporter_red,iron_ingot": {
    output: "utilitycraft:export_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_exporter_yellow,iron_ingot": {
    output: "utilitycraft:export_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_importer,iron_ingot": {
    output: "utilitycraft:import_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_importer_blue,iron_ingot": {
    output: "utilitycraft:import_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_importer_purple,iron_ingot": {
    output: "utilitycraft:import_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_importer_red,iron_ingot": {
    output: "utilitycraft:import_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,silicon,storage_core,silicon,iron_ingot,item_importer_yellow,iron_ingot": {
    output: "utilitycraft:import_buffer",
    amount: 1,
  },
  "iron_ingot,fluxite,iron_ingot,air,air,air,air,air,air": {
    output: "utilitycraft:network_cable",
    amount: 8,
  },
  "cell_casing,storage_part,air,air,air,air,air,air,air": {
    output: "utilitycraft:storage_cell",
    amount: 1,
  },
  "iron_ingot,storage_core,iron_ingot,fluxite,chest,fluxite,iron_ingot,redstone,iron_ingot": {
    output: "utilitycraft:storage_cell_drive",
    amount: 1,
  },
  "iron_ingot,storage_core,iron_ingot,silicon,fluxite_block,silicon,iron_ingot,redstone_block,iron_ingot": {
    output: "utilitycraft:storage_center",
    amount: 1,
  },
  "gold_dust,silicon,gold_dust,fluxite,steel_plate,fluxite,redstone,iron_ingot,redstone": {
    output: "utilitycraft:storage_core",
    amount: 1,
  },
  "tinted_glass,silicon,tinted_glass,silicon,storage_core,silicon,glowstone_dust,chip,glowstone_dust": {
    output: "utilitycraft:storage_part",
    amount: 1,
  },
  "iron_ingot,storage_core,iron_ingot,redstone,tinted_glass,redstone,iron_ingot,fluxite,iron_ingot": {
    output: "utilitycraft:storage_terminal",
    amount: 1,
  },
  "iron_ingot,redstone_block,iron_ingot,gold_dust,storage_cell_drive,gold_dust,iron_ingot,fluxite,iron_ingot": {
    output: "utilitycraft:storage_transfer_station",
    amount: 1,
  },
  "cell_casing,ultimate_storage_part,air,air,air,air,air,air,air": {
    output: "utilitycraft:ultimate_storage_cell",
    amount: 1,
  },
  "tinted_glass,expert_storage_part,tinted_glass,expert_storage_part,storage_core,expert_storage_part,glowstone_dust,ultimate_chip,glowstone_dust": {
    output: "utilitycraft:ultimate_storage_part",
    amount: 1,
  },
};

DoriosLib.registry.registerCrafterRecipe(digitalStorageCrafterRecipes);

system.afterEvents.scriptEventReceive.subscribe(({ id, message }) => {
  if (id !== "utilitycraft:register_crafter_recipe") return;

  try {
    const payload = JSON.parse(message);
    if (!payload || typeof payload !== "object") return;

    for (const [pattern, data] of Object.entries(payload)) {
      if (pattern.split(",").length !== 9) {
        console.warn(`[UtilityCraft] Invalid Crafter pattern '${pattern}' (must have 9 slots).`);
        continue;
      }
      if (!data?.output || typeof data.output !== "string") continue;

      crafterRecipes[pattern] = data;
    }
  } catch (error) {
    console.warn("[UtilityCraft] Failed to parse crafter registration payload:", error);
  }
});
