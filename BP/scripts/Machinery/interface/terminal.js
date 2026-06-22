import { ItemStack } from "@minecraft/server";
import { ButtonManager, TickScheduler } from "DoriosCore/index.js";
import { createItemFromKey, getItemKey } from "../storage_v2/item_registry.js";
import {
  addItem,
  getNetworkSnapshot,
  getSortedItems,
} from "../storage_v2/network_runtime.js";

const DEFAULT_FILLER_ID = "utilitycraft:storage_filler";
const DEFAULT_BUTTON_ID = "utilitycraft:ui_filler";

/**
 * Shared terminal UI renderer for Digital Storage interfaces.
 *
 * This class owns the common inventory layout, page state, controls, display
 * item rendering, and count-column labels. Machine files should provide only
 * block/entity lifecycle wiring and feature-specific extensions.
 */
export class StorageTerminalInterface {
  constructor(config = {}) {
    this.machineId = config.machineId ?? "storage_terminal";
    this.entityType = config.entityType ?? "utilitycraft:storage_terminal";

    this.burnSlots = config.burnSlots ?? [0, 1, 2, 3];
    this.visibleBurnSlot = config.visibleBurnSlot ?? this.burnSlots[0];

    this.gridStart = config.gridStart ?? 4;
    this.gridColumns = config.gridColumns ?? 9;
    this.gridRows = config.gridRows ?? 18;
    this.gridSize = this.gridColumns * this.gridRows;
    this.gridEnd = this.gridStart + this.gridSize - 1;

    this.reloadSlot = config.reloadSlot ?? 166;
    this.previousSlot = config.previousSlot ?? 167;
    this.nextSlot = config.nextSlot ?? 168;
    this.controlSlots = [this.reloadSlot, this.previousSlot, this.nextSlot];

    this.countLabelBaseSlot = config.countLabelBaseSlot ?? 169;
    this.countLabelColumns = config.countLabelColumns ?? this.gridColumns;
    this.countLabelRows = config.countLabelRows ?? this.gridRows;

    this.fillerId = config.fillerId ?? DEFAULT_FILLER_ID;
    this.buttonId = config.buttonId ?? DEFAULT_BUTTON_ID;
  }

  registerButtons() {
    ButtonManager.registerMachineButton(this.machineId, this.controlSlots, ({ entity, slot }) => {
      return this.handleControlPress(entity, slot);
    });
  }

  setupEntity(entity) {
    if (!entity?.isValid) return;

    entity.setDynamicProperty("ucds:terminal_page", 0);
    entity.setDynamicProperty("ucds:terminal_last_page", -1);
    entity.setDynamicProperty("ucds:terminal_last_network", 0);
    entity.setDynamicProperty("ucds:terminal_last_change_seq", -1);
    entity.setDynamicProperty("ucds:terminal_force_render", true);

    const inv = this.getInventory(entity);
    if (!inv) return;

    this.clearBurnSlots(inv);
    this.clearGrid(inv);
    this.clearCountLabels(inv);
    this.renderControls(entity, 0, 1);
  }

  linkNetwork(entity, networkId) {
    if (!entity?.isValid) return false;

    const id = Math.floor(Number(networkId) || 0);
    if (!id) return false;

    entity.setDynamicProperty("ucds:network_id", id);
    entity.setDynamicProperty("ucds:terminal_page", 0);
    entity.setDynamicProperty("ucds:terminal_force_render", true);
    return true;
  }

  tick(entity) {
    if (!entity?.isValid) return;

    const hasOpenUI = TickScheduler.hasOpenUI(entity);
    if (!hasOpenUI && !TickScheduler.shouldProcessMachine(entity)) return;

    const inv = this.getInventory(entity);
    if (!inv) return;

    ButtonManager.ensureWatching(entity, this.machineId);

    const networkId = this.getLinkedNetworkId(entity);
    if (!networkId) {
      if (entity.getDynamicProperty("ucds:terminal_last_network") !== 0) {
        this.renderEmpty(entity, inv);
      }
      return;
    }

    const snapshot = getNetworkSnapshot(networkId);
    if (!snapshot) {
      this.renderEmpty(entity, inv);
      return;
    }

    const pageCount = this.getPageCount(snapshot);
    const page = this.clampPage(entity, pageCount);
    const forceRender = entity.getDynamicProperty("ucds:terminal_force_render") === true;
    const lastNetwork = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_network") || 0));
    const lastPage = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_page") ?? -1));
    const lastChangeSeq = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_change_seq") ?? -1));

    if (
      forceRender ||
      lastNetwork !== networkId ||
      lastPage !== page ||
      lastChangeSeq !== snapshot.changeSeq
    ) {
      this.renderPage(entity, inv, snapshot, page, pageCount);
    }

    this.processBurnSlots(entity, inv, networkId);
  }

  handleControlPress(entity, slot) {
    if (!entity?.isValid) return undefined;

    const networkId = this.getLinkedNetworkId(entity);
    const snapshot = networkId ? getNetworkSnapshot(networkId) : undefined;
    const pageCount = snapshot ? this.getPageCount(snapshot) : 1;
    const page = this.clampPage(entity, pageCount);

    if (slot === this.reloadSlot) {
      entity.setDynamicProperty("ucds:terminal_force_render", true);
    } else if (slot === this.previousSlot) {
      entity.setDynamicProperty("ucds:terminal_page", Math.max(0, page - 1));
      entity.setDynamicProperty("ucds:terminal_force_render", true);
    } else if (slot === this.nextSlot) {
      entity.setDynamicProperty("ucds:terminal_page", Math.min(pageCount - 1, page + 1));
      entity.setDynamicProperty("ucds:terminal_force_render", true);
    }

    this.renderControls(entity, this.clampPage(entity, pageCount), pageCount);
    return this.getControlName(slot, this.clampPage(entity, pageCount), pageCount);
  }

  renderPage(entity, inv, snapshot, page, pageCount) {
    const networkId = snapshot.networkId;
    const entries = getSortedItems(networkId, "count");
    const start = page * this.gridSize;
    const pageEntries = entries.slice(start, start + this.gridSize);

    const renderedSlots = {};
    const countColumns = this.createEmptyCountColumns();

    for (let i = 0; i < this.gridSize; i++) {
      const slot = this.gridStart + i;
      const entry = pageEntries[i];

      if (!entry) {
        this.setFiller(inv, slot);
        continue;
      }

      const [itemKey, count] = entry;
      const item = this.createDisplayItem(itemKey, count);
      inv.setItem(slot, item);
      this.setCountColumnValue(countColumns, i, count);
      renderedSlots[itemKey] = slot;
    }

    this.writeCountColumns(inv, countColumns);
    this.renderControls(entity, page, pageCount);
    entity.setDynamicProperty("ucds:terminal_rendered_slots", JSON.stringify(renderedSlots));
    entity.setDynamicProperty("ucds:terminal_last_network", networkId);
    entity.setDynamicProperty("ucds:terminal_last_page", page);
    entity.setDynamicProperty("ucds:terminal_last_change_seq", snapshot.changeSeq);
    entity.setDynamicProperty("ucds:terminal_force_render", false);
  }

  renderEmpty(entity, inv) {
    this.clearGrid(inv);
    this.clearCountLabels(inv);
    this.renderControls(entity, 0, 1);
    entity.setDynamicProperty("ucds:terminal_rendered_slots", "{}");
    entity.setDynamicProperty("ucds:terminal_last_network", 0);
    entity.setDynamicProperty("ucds:terminal_last_page", 0);
    entity.setDynamicProperty("ucds:terminal_last_change_seq", -1);
    entity.setDynamicProperty("ucds:terminal_force_render", false);
  }

  renderControls(entity, page, pageCount) {
    const inv = this.getInventory(entity);
    if (!inv) return;

    this.setButton(inv, this.reloadSlot, "§r§7- Reload");
    this.setButton(inv, this.previousSlot, `§r§7- Previous Page §f${page + 1}/${pageCount}`);
    this.setButton(inv, this.nextSlot, `§r§7- Next Page §f${page + 1}/${pageCount}`);
  }

  processBurnSlots(entity, inv, networkId) {
    let insertedAny = false;

    for (const slot of this.burnSlots) {
      const item = inv.getItem(slot);
      if (!item) continue;

      const itemKey = getItemKey(item);
      if (!itemKey) continue;

      const result = addItem(networkId, itemKey, item.amount, "terminal_burn_slot");
      if (result.inserted <= 0) continue;

      insertedAny = true;
      if (result.remaining <= 0) {
        inv.setItem(slot, undefined);
        continue;
      }

      item.amount = result.remaining;
      inv.setItem(slot, item);
    }

    if (!insertedAny) return;

    const snapshot = getNetworkSnapshot(networkId);
    if (snapshot) {
      entity.setDynamicProperty("ucds:terminal_last_change_seq", snapshot.changeSeq);
    }
  }

  getLinkedNetworkId(entity) {
    return Math.floor(Number(entity?.getDynamicProperty("ucds:network_id") || 0));
  }

  getPageCount(snapshot) {
    const itemCount = Object.keys(snapshot?.totals ?? {}).length;
    return Math.max(1, Math.ceil(itemCount / this.gridSize));
  }

  clampPage(entity, pageCount) {
    const current = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_page") || 0));
    const page = Math.max(0, Math.min(current, Math.max(1, pageCount) - 1));
    if (page !== current) entity.setDynamicProperty("ucds:terminal_page", page);
    return page;
  }

  createDisplayItem(itemKey, count) {
    const probe = createItemFromKey(itemKey, 1);
    const maxAmount = Math.max(1, Math.floor(Number(probe.maxAmount) || 64));
    return createItemFromKey(itemKey, Math.max(1, Math.min(maxAmount, Math.floor(Number(count) || 1))));
  }

  setCountLabel(inv, slot, count) {
    const relativeSlot = slot - this.gridStart;
    if (relativeSlot < 0 || relativeSlot >= this.gridSize) return;

    const column = relativeSlot % this.countLabelColumns;
    const row = Math.floor(relativeSlot / this.countLabelColumns);
    if (column < 0 || column >= this.countLabelColumns || row < 0 || row >= this.countLabelRows) return;

    const labelSlot = this.countLabelBaseSlot + column;
    let labelItem = inv.getItem(labelSlot);
    if (!labelItem || labelItem.typeId !== this.buttonId) {
      labelItem = new ItemStack(this.buttonId, 1);
      labelItem.nameTag = " ";
    }

    const lore = labelItem.getLore() ?? [];
    while (lore.length < this.countLabelRows) lore.push(" ");
    lore[row] = count > 1 ? `§r§f${this.formatCount(count)}` : " ";
    labelItem.setLore(lore.slice(0, this.countLabelRows));
    inv.setItem(labelSlot, labelItem);
  }

  createEmptyCountColumns() {
    return Array.from(
      { length: this.countLabelColumns },
      () => Array(this.countLabelRows).fill(" "),
    );
  }

  setCountColumnValue(columns, relativeSlot, count) {
    if (relativeSlot < 0 || relativeSlot >= this.gridSize) return;

    const column = relativeSlot % this.countLabelColumns;
    const row = Math.floor(relativeSlot / this.countLabelColumns);
    if (!columns[column] || row < 0 || row >= this.countLabelRows) return;

    columns[column][row] = count > 1 ? `§r§f${this.formatCount(count)}` : " ";
  }

  writeCountColumns(inv, columns) {
    for (let column = 0; column < this.countLabelColumns; column++) {
      const label = new ItemStack(this.buttonId, 1);
      label.nameTag = " ";
      label.setLore(columns[column] ?? Array(this.countLabelRows).fill(" "));
      inv.setItem(this.countLabelBaseSlot + column, label);
    }
  }

  formatCount(value) {
    const count = Math.floor(Number(value) || 0);
    if (count < 1000) return String(count);

    const units = ["K", "M", "B", "T", "Qa", "Qi"];
    let scaled = count;
    let unit = "";
    for (const nextUnit of units) {
      if (scaled < 1000) break;
      scaled /= 1000;
      unit = nextUnit;
    }

    const text = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
    return `${text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")}${unit}`;
  }

  clearBurnSlots(inv) {
    for (const slot of this.burnSlots) inv.setItem(slot, undefined);
  }

  clearGrid(inv) {
    for (let slot = this.gridStart; slot <= this.gridEnd; slot++) {
      this.setFiller(inv, slot);
    }
  }

  clearCountLabels(inv) {
    for (let column = 0; column < this.countLabelColumns; column++) {
      const label = new ItemStack(this.buttonId, 1);
      label.nameTag = " ";
      label.setLore(Array(this.countLabelRows).fill(" "));
      inv.setItem(this.countLabelBaseSlot + column, label);
    }
  }

  setFiller(inv, slot) {
    const filler = new ItemStack(this.fillerId, 1);
    filler.nameTag = "§rStorage Slot";
    inv.setItem(slot, filler);
  }

  setButton(inv, slot, nameTag) {
    const item = new ItemStack(this.buttonId, 1);
    item.nameTag = nameTag;
    inv.setItem(slot, item);
  }

  getControlName(slot, page, pageCount) {
    if (slot === this.reloadSlot) return "§r§7- Reload";
    if (slot === this.previousSlot) return `§r§7- Previous Page §f${page + 1}/${pageCount}`;
    if (slot === this.nextSlot) return `§r§7- Next Page §f${page + 1}/${pageCount}`;
    return undefined;
  }

  getInventory(entity) {
    return entity?.getComponent("minecraft:inventory")?.container;
  }
}
