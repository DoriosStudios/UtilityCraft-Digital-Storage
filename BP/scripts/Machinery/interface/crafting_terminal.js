import { ItemStack, system } from "@minecraft/server";
import * as DoriosLib from "DoriosLib/index.js";
import { crafterRecipes } from "Config/recipes/crafter.js";
import { attachOutputToken, materializeOutputItem, readOutputToken } from "./terminal_output.js";
import { StorageTerminalInterface, STORAGE_TERMINAL_CONFIG } from "./terminal.js";
import { createItemFromKey, getItemKey } from "../storage/item_registry.js";
import { addItem, addItemStack, getNetworkSnapshot, removeItem } from "../storage/network_runtime.js";

const CRAFTING_TERMINAL_ENTITY_TYPE = "utilitycraft:crafting_terminal";
const CRAFTING_TERMINAL_MACHINE_ID = "crafting_terminal";
const CRAFT_QTY_SLOT = 178;
const CLEAR_RECIPE_SLOT = 179;
const CRAFTING_GRID = [180, 181, 182, 183, 184, 185, 186, 187, 188];
const OUTPUT_SLOT = 189;
const CRAFT_SLOT = 190;
const OUTPUT_MODE_SLOT = 191;
const CRAFTING_INVENTORY_SIZE = OUTPUT_MODE_SLOT + 1;
const CRAFT_MULTIPLIERS = [1, 2, 4, 8, 16, 64];
const STORAGE_FILLER_ID = "utilitycraft:storage_filler";
const CRAFT_RECIPE_PROPERTY = "ucds:craft_recipe";
const CRAFT_GRID_HASH_PROPERTY = "ucds:craft_grid_hash";
const CRAFT_RESOLVING_PROPERTY = "ucds:craft_resolving";
const CRAFT_QTY_PROPERTY = "ucds:craft_qty";
const CRAFT_OUTPUT_MODE_PROPERTY = "ucds:craft_output_mode";
const CRAFT_LAST_PREVIEW_PROPERTY = "ucds:craft_last_preview";
const MIN_Y_BY_DIMENSION = {
  "minecraft:overworld": DoriosLib.constants.DIMENSIONS.overworld.minY,
  "minecraft:nether": DoriosLib.constants.DIMENSIONS.nether.minY,
  "minecraft:the_end": DoriosLib.constants.DIMENSIONS.end.minY,
};
const activeRecipeResolutions = new Map();
const activeResolutionLanes = new Map();

function hashString(value) {
  let hash = 0;
  for (const character of String(value ?? "")) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return hash >>> 0;
}

function allocateResolutionLane(entity, block, minY) {
  const chunkX = Math.floor(block.location.x / 16) * 16;
  const chunkZ = Math.floor(block.location.z / 16) * 16;
  const seed = hashString(entity.id) % 256;

  for (let offset = 0; offset < 256; offset++) {
    const lane = (seed + offset) % 256;
    const x = chunkX + (lane % 16);
    const z = chunkZ + Math.floor(lane / 16);
    const key = `${entity.dimension.id}:${x},${z}`;
    if (activeResolutionLanes.has(key)) continue;

    return {
      key,
      crafterLocation: { x, y: minY, z },
      redstoneLocation: { x, y: minY + 1, z },
      outputLocation: { x, y: minY - 1, z },
    };
  }
  return undefined;
}

function getItemEntityIds(dimension, location) {
  try {
    return new Set(dimension.getEntitiesAtBlockLocation(location)
      .filter((entity) => entity.typeId === "minecraft:item")
      .map((entity) => entity.id));
  } catch {
    return new Set();
  }
}

function removeResolutionOutputEntities(session) {
  try {
    for (const entity of session.dimension.getEntitiesAtBlockLocation(session.outputLocation)) {
      if (entity.typeId !== "minecraft:item" || session.initialOutputEntityIds.has(entity.id)) continue;
      entity.remove();
    }
  } catch {}
}

function cleanupRecipeResolutionSession(session) {
  removeResolutionOutputEntities(session);

  if (!session.crafterRestored) {
    try {
      const block = session.dimension.getBlock(session.crafterLocation);
      if (block?.typeId === "minecraft:crafter") {
        for (let slot = 0; slot < CRAFTING_GRID.length; slot++) {
          session.dimension.runCommand(
            `replaceitem block ${session.crafterLocation.x} ${session.crafterLocation.y} ${session.crafterLocation.z} slot.container ${slot} air`,
          );
        }
      }
      session.dimension.setBlockType(session.crafterLocation, session.previousCrafterBlock || "minecraft:bedrock");
      session.crafterRestored = true;
    } catch {}
  }

  if (!session.redstoneRestored) {
    try {
      session.dimension.setBlockType(session.redstoneLocation, session.previousRedstoneBlock || "minecraft:bedrock");
      session.redstoneRestored = true;
    } catch {}
  }
}

function releaseRecipeResolutionSession(session) {
  if (activeRecipeResolutions.get(session.terminalId) === session) {
    activeRecipeResolutions.delete(session.terminalId);
  }
  if (activeResolutionLanes.get(session.laneKey) === session) {
    activeResolutionLanes.delete(session.laneKey);
  }
}

/**
 * Cancels the physical recipe probe owned by one terminal. Cleanup is attempted
 * immediately and its scheduled callback repeats it as a watchdog.
 *
 * @param {import("@minecraft/server").Entity | undefined} entity
 * @returns {boolean} True when a live resolution was cancelled.
 */
export function cancelCraftingRecipeResolution(entity) {
  const session = entity?.id ? activeRecipeResolutions.get(entity.id) : undefined;
  if (!session) return false;

  session.cancelled = true;
  activeRecipeResolutions.delete(session.terminalId);
  cleanupRecipeResolutionSession(session);
  try {
    if (entity.isValid) {
      entity.setDynamicProperty(CRAFT_RESOLVING_PROPERTY, false);
      entity.setDynamicProperty(CRAFT_RECIPE_PROPERTY, undefined);
    }
  } catch {}
  return true;
}

export const CRAFTING_TERMINAL_CONFIG = {
  ...STORAGE_TERMINAL_CONFIG,
  machineId: CRAFTING_TERMINAL_MACHINE_ID,
  entityType: CRAFTING_TERMINAL_ENTITY_TYPE,
  entityName: "crafting_terminal",
  inventorySize: CRAFTING_INVENTORY_SIZE,
  slots: {
    ...STORAGE_TERMINAL_CONFIG.slots,
    controls: [
      ...STORAGE_TERMINAL_CONFIG.slots.controls,
      CRAFT_QTY_SLOT,
      CLEAR_RECIPE_SLOT,
      CRAFT_SLOT,
      OUTPUT_MODE_SLOT,
    ],
    craftQty: CRAFT_QTY_SLOT,
    clearRecipe: CLEAR_RECIPE_SLOT,
    craftingGrid: CRAFTING_GRID,
    output: OUTPUT_SLOT,
    craft: CRAFT_SLOT,
    outputMode: OUTPUT_MODE_SLOT,
  },
};

export class CraftingTerminalInterface extends StorageTerminalInterface {
  static get config() {
    return CRAFTING_TERMINAL_CONFIG;
  }

  setup() {
    super.setup();
    if (!this.valid) return;

    this.entity.setDynamicProperty(CRAFT_QTY_PROPERTY, 1);
    this.entity.setDynamicProperty(CRAFT_OUTPUT_MODE_PROPERTY, "inventory");
    this.entity.setDynamicProperty(CRAFT_GRID_HASH_PROPERTY, "");
    this.entity.setDynamicProperty(CRAFT_RECIPE_PROPERTY, undefined);
    this.entity.setDynamicProperty(CRAFT_RESOLVING_PROPERTY, false);
    this.entity.setDynamicProperty(CRAFT_LAST_PREVIEW_PROPERTY, "");
    this.renderCraftingControls();
    this.renderOutputPreview();
  }

  tick() {
    if (!this.valid) return;

    super.tick();
    if (!this.shouldProcess || !this.shouldUpdateUI) return;

    this.tickCraftingSection();
  }

  destroy() {
    cancelCraftingRecipeResolution(this.entity);
    this.dropCraftingGridItems();
    super.destroy();
  }

  handleControlPress(slot) {
    if (STORAGE_TERMINAL_CONFIG.slots.controls.includes(slot)) {
      return super.handleControlPress(slot);
    }

    if (slot === CRAFT_QTY_SLOT) {
      this.entity.setDynamicProperty(CRAFT_QTY_PROPERTY, this.getNextCraftQty());
    } else if (slot === CLEAR_RECIPE_SLOT) {
      this.clearCraftingGrid();
    } else if (slot === CRAFT_SLOT) {
      this.performCraft();
    } else if (slot === OUTPUT_MODE_SLOT) {
      this.entity.setDynamicProperty(CRAFT_OUTPUT_MODE_PROPERTY, this.getOutputMode() === "network" ? "inventory" : "network");
    }

    this.renderCraftingControls();
    this.tickCraftingSection();
    return this.getCraftingControlName(slot);
  }

  renderControls(entity, page, pageCount) {
    super.renderControls(entity, page, pageCount);
    this.renderCraftingControls();
  }

  tickCraftingSection() {
    this.materializeGridOutputTokens();

    const gridHash = this.getGridHash();
    const isResolving = this.entity.getDynamicProperty(CRAFT_RESOLVING_PROPERTY) === true;
    if (!isResolving && gridHash !== this.entity.getDynamicProperty(CRAFT_GRID_HASH_PROPERTY)) {
      this.entity.setDynamicProperty(CRAFT_GRID_HASH_PROPERTY, gridHash);
      this.entity.setDynamicProperty(CRAFT_RECIPE_PROPERTY, undefined);
      this.entity.setDynamicProperty(CRAFT_LAST_PREVIEW_PROPERTY, "");
      this.entity.setDynamicProperty(CRAFT_RESOLVING_PROPERTY, true);
      this.renderOutputPreview();
      this.resolveRecipeAsync(CRAFTING_GRID.map((slot) => this.container.getItem(slot)));
      return;
    }

    this.renderOutputPreview();
  }

  resolveRecipeAsync(gridItems) {
    const minY = MIN_Y_BY_DIMENSION[this.dimension.id];
    if (!Number.isFinite(minY)) {
      this.entity.setDynamicProperty(CRAFT_RESOLVING_PROPERTY, false);
      return;
    }

    cancelCraftingRecipeResolution(this.entity);
    const lane = allocateResolutionLane(this.entity, this.block, minY);
    if (!lane) {
      this.entity.setDynamicProperty(CRAFT_RESOLVING_PROPERTY, false);
      this.entity.setDynamicProperty(CRAFT_GRID_HASH_PROPERTY, "__retry__");
      return;
    }

    const session = {
      terminalId: this.entity.id,
      entity: this.entity,
      dimension: this.dimension,
      laneKey: lane.key,
      crafterLocation: lane.crafterLocation,
      redstoneLocation: lane.redstoneLocation,
      outputLocation: lane.outputLocation,
      previousCrafterBlock: this.dimension.getBlock(lane.crafterLocation)?.typeId,
      previousRedstoneBlock: this.dimension.getBlock(lane.redstoneLocation)?.typeId,
      initialOutputEntityIds: getItemEntityIds(this.dimension, lane.outputLocation),
      crafterRestored: false,
      redstoneRestored: false,
      cancelled: false,
    };
    activeRecipeResolutions.set(session.terminalId, session);
    activeResolutionLanes.set(session.laneKey, session);

    const materialMap = {};
    const recipeParts = [];
    let materialCount = 0;

    try {
      this.dimension.setBlockType(session.crafterLocation, "minecraft:crafter");
      for (let index = 0; index < CRAFTING_GRID.length; index++) {
        const item = gridItems[index];
        if (!item) {
          recipeParts.push("air");
          continue;
        }

        materialCount += 1;
        const itemKey = getItemKey(item);
        materialMap[itemKey] = (materialMap[itemKey] ?? 0) + 1;
        recipeParts.push(item.typeId.split(":")[1] ?? item.typeId);
        this.dimension.runCommand(
          `replaceitem block ${session.crafterLocation.x} ${session.crafterLocation.y} ${session.crafterLocation.z} slot.container ${index} ${item.typeId}`,
        );
      }

      if (materialCount <= 0) {
        this.finishRecipeResolve(session, undefined);
        return;
      }

      this.dimension.setBlockType(session.redstoneLocation, "minecraft:redstone_block");
    } catch (error) {
      console.warn(`[DigitalStorage] Crafting Terminal recipe setup failed: ${error?.message ?? error}`);
      this.finishRecipeResolve(session, undefined);
      return;
    }

    system.runTimeout(() => {
      let recipe;
      try {
        if (!session.cancelled) {
          recipe = this.createRecipeFromResolvedItems(session, materialMap, recipeParts.join(","));
        }
      } catch (error) {
        console.warn(`[DigitalStorage] Crafting Terminal recipe read failed: ${error?.message ?? error}`);
      } finally {
        this.finishRecipeResolve(session, recipe);
      }
    }, 9);
  }

  createRecipeFromResolvedItems(session, materialMap, recipeString) {
    const outputs = [];
    const itemEntities = session.dimension
      .getEntitiesAtBlockLocation(session.outputLocation)
      .filter((entity) => entity.typeId === "minecraft:item" && !session.initialOutputEntityIds.has(entity.id));

    for (const itemEntity of itemEntities) {
      const itemStack = itemEntity.getComponent("minecraft:item")?.itemStack;
      if (!itemStack) continue;

      const itemKey = getItemKey(itemStack);
      if (itemKey) outputs.push({ id: itemKey, amount: itemStack.amount });
      itemEntity.remove();
    }

    if (outputs.length === 0) outputs.push(...this.getFallbackRecipeOutputs(recipeString));

    const materials = Object.entries(materialMap)
      .filter(([id, amount]) => id && amount > 0)
      .map(([id, amount]) => ({ id, amount }));

    if (materials.length === 0 || outputs.length === 0) return undefined;
    return {
      materials,
      outputs: this.mergeAmounts(outputs),
    };
  }

  finishRecipeResolve(session, recipe) {
    cleanupRecipeResolutionSession(session);
    releaseRecipeResolutionSession(session);
    if (session.cancelled || !this.entity?.isValid) return;

    this.entity.setDynamicProperty(CRAFT_RECIPE_PROPERTY, recipe ? JSON.stringify(recipe) : undefined);
    this.entity.setDynamicProperty(CRAFT_RESOLVING_PROPERTY, false);
    this.renderOutputPreview();
  }

  performCraft() {
    const recipe = this.getRecipe();
    if (!recipe) return false;

    const source = this.getCraftSource(recipe);
    if (!source) return false;

    const crafts = Math.min(this.getCraftQty(), source.maxCrafts);
    if (crafts <= 0 || !this.consumeCraftMaterials(recipe, source.type, crafts)) return false;

    this.deliverOutputs(recipe.outputs, crafts);
    this.entity.setDynamicProperty("ucds:terminal_force_render", true);
    return true;
  }

  getCraftSource(recipe) {
    const totals = getNetworkSnapshot(this.networkId)?.totals ?? {};
    let possibleCrafts = Infinity;

    for (const material of recipe.materials) {
      const available = Math.floor(Number(totals[material.id] ?? 0))
        + this.countItemsInGrid(material.id);
      const crafts = Math.floor(available / material.amount);
      if (crafts <= 0) return undefined;
      possibleCrafts = Math.min(possibleCrafts, crafts);
    }

    return possibleCrafts === Infinity ? undefined : { type: "combined", maxCrafts: possibleCrafts };
  }

  consumeCraftMaterials(recipe, _source, crafts) {
    const gridSnapshot = new Map(CRAFTING_GRID.map((slot) => [slot, this.container.getItem(slot)?.clone()]));
    const removedFromNetwork = [];
    const totals = getNetworkSnapshot(this.networkId)?.totals ?? {};

    for (const material of recipe.materials) {
      let remaining = material.amount * crafts;
      const availableInNetwork = Math.max(0, Math.floor(Number(totals[material.id] ?? 0)));
      if (this.networkId && availableInNetwork > 0) {
        const result = removeItem(
          this.networkId,
          material.id,
          Math.min(remaining, availableInNetwork),
          "crafting_terminal_input",
        );
        if (result.removed > 0) {
          removedFromNetwork.push({
            id: material.id,
            amount: result.removed,
            itemStack: result.itemStack,
          });
          remaining -= result.removed;
        }
      }

      if (remaining > 0) remaining -= this.consumeGridMaterial(material.id, remaining);
      if (remaining <= 0) continue;

      this.restoreCraftingGrid(gridSnapshot);
      this.restoreNetworkMaterials(removedFromNetwork);
      return false;
    }

    return true;
  }

  consumeGridMaterial(itemKey, amount) {
    let remaining = Math.max(0, Math.floor(Number(amount) || 0));
    for (const slot of CRAFTING_GRID) {
      if (remaining <= 0) break;

      const item = this.container.getItem(slot);
      if (!item || getItemKey(item) !== itemKey) continue;

      const take = Math.min(item.amount, remaining);
      remaining -= take;
      if (take >= item.amount) this.container.setItem(slot, undefined);
      else {
        item.amount -= take;
        this.container.setItem(slot, item);
      }
    }
    return Math.max(0, Math.floor(Number(amount) || 0)) - remaining;
  }

  restoreCraftingGrid(snapshot) {
    for (const [slot, item] of snapshot) this.container.setItem(slot, item);
  }

  restoreNetworkMaterials(removedItems) {
    if (!this.networkId) return;
    for (const removed of removedItems) {
      if (removed.itemStack) {
        addItemStack(this.networkId, removed.itemStack, "crafting_terminal_rollback");
      } else {
        addItem(this.networkId, removed.id, removed.amount, "crafting_terminal_rollback");
      }
    }
  }

  deliverOutputs(outputs, crafts) {
    const toNetwork = this.getOutputMode() === "network" && this.networkId;

    for (const output of outputs) {
      for (const stack of this.splitItemAmount(output.id, output.amount * crafts)) {
        if (!toNetwork) {
          this.deliverItemStack(stack);
          continue;
        }

        const result = addItem(this.networkId, output.id, stack.amount, "crafting_terminal_output");
        if (result.remaining <= 0) continue;

        stack.amount = result.remaining;
        this.deliverItemStack(stack);
      }
    }
  }

  deliverItemStack(stack) {
    this.dimension.spawnItem(stack, this.block.center());
  }

  renderCraftingControls() {
    if (!this.container) return;

    this.setButton(this.container, CRAFT_QTY_SLOT, `\u00A7r\u00A7fx${this.getCraftQty()}`);
    this.setButton(this.container, CLEAR_RECIPE_SLOT, "\u00A7r\u00A7cClear Recipe");
    this.setButton(this.container, CRAFT_SLOT, "\u00A7r\u00A7fCraft");
    this.setButton(
      this.container,
      OUTPUT_MODE_SLOT,
      this.getOutputMode() === "network" ? "\u00A7r\u00A7fTo Network" : "\u00A7r\u00A7fTo Inventory",
    );
  }

  renderOutputPreview() {
    const recipe = this.getRecipe();
    const output = recipe?.outputs?.[0];

    if (!output || this.entity.getDynamicProperty(CRAFT_RESOLVING_PROPERTY) === true) {
      this.setOutputFiller();
      this.entity.setDynamicProperty(CRAFT_LAST_PREVIEW_PROPERTY, "");
      return;
    }

    const previewKey = `${output.id}:${output.amount}`;
    const probe = createItemFromKey(output.id, 1);
    const currentPreview = this.container.getItem(OUTPUT_SLOT);
    if (
      this.entity.getDynamicProperty(CRAFT_LAST_PREVIEW_PROPERTY) === previewKey &&
      currentPreview?.typeId === probe.typeId &&
      readOutputToken(currentPreview)
    ) {
      return;
    }

    const amount = Math.max(1, Math.min(Math.floor(Number(output.amount) || 1), probe.maxAmount ?? 64));
    const preview = createItemFromKey(output.id, amount);
    attachOutputToken(preview, {
      terminalId: this.getTerminalId(this.entity),
      networkId: 0,
      slot: OUTPUT_SLOT,
      itemKey: output.id,
      amount,
      totalCount: output.amount,
    });
    this.container.setItem(OUTPUT_SLOT, preview);
    this.entity.setDynamicProperty(CRAFT_LAST_PREVIEW_PROPERTY, previewKey);
  }

  clearCraftingGrid() {
    for (const slot of CRAFTING_GRID) {
      const item = this.container.getItem(slot);
      this.container.setItem(slot, undefined);
      this.returnOrDropItem(item, "crafting_terminal_clear");
    }

    this.entity.setDynamicProperty(CRAFT_RECIPE_PROPERTY, undefined);
    this.entity.setDynamicProperty(CRAFT_GRID_HASH_PROPERTY, "");
    this.entity.setDynamicProperty(CRAFT_LAST_PREVIEW_PROPERTY, "");
    this.setOutputFiller();
  }

  materializeGridOutputTokens() {
    for (const slot of CRAFTING_GRID) {
      const item = this.container.getItem(slot);
      if (!item) continue;

      if (this.isUiElementItem(item)) {
        this.container.setItem(slot, undefined);
        continue;
      }

      const materialized = materializeOutputItem(item);
      if (materialized.handled) this.container.setItem(slot, materialized.item);
    }
  }

  dropCraftingGridItems() {
    if (!this.container) return;

    const dropLocation = this.block.center();
    for (const slot of CRAFTING_GRID) {
      const item = this.container.getItem(slot);
      if (!item) continue;

      if (this.isUiElementItem(item)) {
        this.container.setItem(slot, undefined);
        continue;
      }

      const materialized = materializeOutputItem(item);
      const realItem = materialized.item ?? (!materialized.handled ? item : undefined);
      if (realItem) this.dimension.spawnItem(realItem, dropLocation);
      this.container.setItem(slot, undefined);
    }
  }

  returnOrDropItem(item, reason) {
    if (!item || this.isUiElementItem(item)) return;

    const materialized = materializeOutputItem(item);
    const realItem = materialized.item ?? (!materialized.handled ? item : undefined);
    if (!realItem) return;

    if (this.networkId) {
      const result = addItemStack(this.networkId, realItem, reason);
      if (result.remaining <= 0) return;
      realItem.amount = result.remaining;
    }

    this.dimension.spawnItem(realItem, this.block.center());
  }

  setOutputFiller() {
    const filler = new ItemStack(STORAGE_FILLER_ID, 1);
    filler.nameTag = "\u00A7rOutput Slot";
    this.container.setItem(OUTPUT_SLOT, filler);
  }

  getRecipe() {
    const raw = this.entity.getDynamicProperty(CRAFT_RECIPE_PROPERTY);
    if (!raw || typeof raw !== "string") return undefined;

    try {
      const recipe = JSON.parse(raw);
      if (!Array.isArray(recipe?.materials) || !Array.isArray(recipe?.outputs)) return undefined;
      if (recipe.materials.length === 0 || recipe.outputs.length === 0) return undefined;
      return recipe;
    } catch {
      return undefined;
    }
  }

  getFallbackRecipeOutputs(recipeString) {
    const recipe = crafterRecipes?.[recipeString];
    if (!recipe) return [];

    const outputs = [];
    if (Array.isArray(recipe.outputs)) {
      for (const output of recipe.outputs) {
        const id = output?.id ?? output?.output;
        const amount = Math.max(1, Math.floor(Number(output?.amount) || 1));
        if (id) outputs.push({ id, amount });
      }
    } else if (recipe.output) {
      outputs.push({ id: recipe.output, amount: Math.max(1, Math.floor(Number(recipe.amount) || 1)) });
    }

    const leftovers = Array.isArray(recipe.leftover) ? recipe.leftover : recipe.leftover ? [recipe.leftover] : [];
    for (const leftover of leftovers) {
      const id = typeof leftover === "string" ? leftover : leftover?.id ?? leftover?.output;
      const amount = typeof leftover === "string" ? 1 : Math.max(1, Math.floor(Number(leftover?.amount) || 1));
      if (id) outputs.push({ id, amount });
    }

    return outputs;
  }

  getGridHash() {
    return CRAFTING_GRID.map((slot) => {
      const item = this.container.getItem(slot);
      return item ? getItemKey(item) || item.typeId : "air";
    }).join("|");
  }

  countItemsInGrid(itemKey) {
    let total = 0;
    for (const slot of CRAFTING_GRID) {
      const item = this.container.getItem(slot);
      if (item && getItemKey(item) === itemKey) total += item.amount;
    }
    return total;
  }

  getCraftQty() {
    const value = Number(this.entity.getDynamicProperty(CRAFT_QTY_PROPERTY) ?? 1);
    return CRAFT_MULTIPLIERS.includes(value) ? value : 1;
  }

  getNextCraftQty() {
    const index = CRAFT_MULTIPLIERS.indexOf(this.getCraftQty());
    return CRAFT_MULTIPLIERS[(index + 1) % CRAFT_MULTIPLIERS.length];
  }

  getOutputMode() {
    return this.entity.getDynamicProperty(CRAFT_OUTPUT_MODE_PROPERTY) === "network" ? "network" : "inventory";
  }

  getCraftingControlName(slot) {
    if (slot === CRAFT_QTY_SLOT) return `\u00A7r\u00A7fx${this.getCraftQty()}`;
    if (slot === CLEAR_RECIPE_SLOT) return "\u00A7r\u00A7cClear Recipe";
    if (slot === CRAFT_SLOT) return "\u00A7r\u00A7fCraft";
    if (slot === OUTPUT_MODE_SLOT) return this.getOutputMode() === "network" ? "\u00A7r\u00A7fTo Network" : "\u00A7r\u00A7fTo Inventory";
    return undefined;
  }

  splitItemAmount(itemKey, amount) {
    const stacks = [];
    let remaining = Math.max(0, Math.floor(Number(amount) || 0));
    if (remaining <= 0) return stacks;

    const maxAmount = Math.max(1, Math.floor(Number(createItemFromKey(itemKey, 1).maxAmount) || 64));
    while (remaining > 0) {
      const stackAmount = Math.min(maxAmount, remaining);
      stacks.push(createItemFromKey(itemKey, stackAmount));
      remaining -= stackAmount;
    }
    return stacks;
  }

  mergeAmounts(items) {
    const amounts = new Map();
    for (const item of items) {
      const id = String(item?.id ?? "");
      const amount = Math.max(0, Math.floor(Number(item?.amount) || 0));
      if (!id || amount <= 0) continue;
      amounts.set(id, (amounts.get(id) ?? 0) + amount);
    }
    return [...amounts.entries()].map(([id, amount]) => ({ id, amount }));
  }
}
