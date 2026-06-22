import { ItemStack } from "@minecraft/server";
import { ButtonManager, TickScheduler } from "DoriosCore/index.js";
import {
  attachOutputToken,
  attachUiSlotToken,
  consumeUiSlotRestores,
  materializeOutputItem,
} from "./terminal_output.js";
import { createItemFromKey, getItemKey } from "../storage_v2/item_registry.js";
import {
  addItem,
  consumeTerminalItemUpdates,
  getNetworkSnapshot,
  getSortedItems,
  registerTerminalDisplay,
  setTerminalRenderedSlots,
  unregisterTerminalDisplay,
} from "../storage_v2/network_runtime.js";

const DEFAULT_FILLER_ID = "utilitycraft:storage_filler";
const DEFAULT_BUTTON_ID = "utilitycraft:ui_filler";
const UI_ELEMENT_TAG = "utilitycraft:ui_element";

/**
 * Shared terminal UI renderer for Digital Storage interfaces.
 *
 * This class owns the common inventory layout, page state, controls, display
 * item rendering, and count-column labels. Machine files should provide only
 * block/entity lifecycle wiring and feature-specific extensions.
 */
export class StorageTerminalInterface {
  /**
   * Creates one reusable terminal UI controller.
   *
   * @param {object} [config] Slot layout and item id overrides.
   */
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
    this.uiOpenState = config.uiOpenState ?? "utilitycraft:ui_open";
  }

  /**
   * Registers button callbacks for the control slots owned by this interface.
   */
  registerButtons() {
    ButtonManager.registerMachineButton(this.machineId, this.controlSlots, ({ entity, slot }) => {
      return this.handleControlPress(entity, slot);
    });
  }

  /**
   * Initializes a freshly spawned terminal entity inventory and render state.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   */
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
    this.clearGrid(inv, entity);
    this.clearCountLabels(inv);
    this.renderControls(entity, 0, 1);
  }

  /**
   * Links a terminal entity to an already-loaded storage network.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {number|string} networkId Network id to link.
   * @returns {boolean} True when the link was accepted.
   */
  linkNetwork(entity, networkId) {
    if (!entity?.isValid) return false;

    const id = Math.floor(Number(networkId) || 0);
    if (!id) return false;

    const previousNetworkId = this.getLinkedNetworkId(entity);
    if (previousNetworkId && previousNetworkId !== id) {
      unregisterTerminalDisplay(previousNetworkId, this.getTerminalId(entity));
    }

    entity.setDynamicProperty("ucds:network_id", id);
    entity.setDynamicProperty("ucds:terminal_page", 0);
    entity.setDynamicProperty("ucds:terminal_force_render", true);
    registerTerminalDisplay(id, this.getTerminalId(entity));
    return true;
  }

  /**
   * Unregisters runtime display state before the backing entity is removed.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   */
  destroyEntity(entity) {
    if (!entity?.isValid) return;

    const networkId = this.getLinkedNetworkId(entity)
      || Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_network") || 0));
    if (networkId) unregisterTerminalDisplay(networkId, this.getTerminalId(entity));
  }

  /**
   * Main terminal tick.
   *
   * Closed terminals only process non-UI work. Open terminals render pages,
   * apply network display updates, and keep the visible grid synchronized.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Block} [block] Terminal block.
   */
  tick(entity, block) {
    if (!entity?.isValid) return;

    const hasOpenUI = TickScheduler.hasOpenUI(entity);
    this.syncOpenTickState(block, hasOpenUI);
    if (!hasOpenUI && !TickScheduler.shouldProcessMachine(entity)) return;

    const inv = this.getInventory(entity);
    if (!inv) return;

    ButtonManager.ensureWatching(entity, this.machineId);
    this.restorePendingUiSlots(entity, inv);

    const networkId = this.getLinkedNetworkId(entity);
    if (!networkId) {
      if (hasOpenUI && entity.getDynamicProperty("ucds:terminal_last_network") !== 0) {
        const lastNetwork = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_network") || 0));
        if (lastNetwork) unregisterTerminalDisplay(lastNetwork, this.getTerminalId(entity));
        this.renderEmpty(entity, inv);
      }
      return;
    }

    this.processBurnSlots(entity, inv, networkId);
    if (!hasOpenUI) return;

    const terminalId = this.getTerminalId(entity);
    const displayState = registerTerminalDisplay(networkId, terminalId);

    const snapshot = getNetworkSnapshot(networkId);
    if (!snapshot) {
      unregisterTerminalDisplay(networkId, terminalId);
      this.renderEmpty(entity, inv);
      return;
    }

    const pageCount = this.getPageCount(snapshot);
    const page = this.clampPage(entity, pageCount);
    const forceRender = entity.getDynamicProperty("ucds:terminal_force_render") === true;
    const lastNetwork = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_network") || 0));
    const lastPage = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_page") ?? -1));
    const hasStoredItems = Object.keys(snapshot.totals ?? {}).length > 0;
    const displayMapped = this.ensureTerminalDisplayMapped(entity, inv, networkId, page, displayState, snapshot);
    const needsDisplayRender = !displayMapped && hasStoredItems;

    if (
      forceRender ||
      lastNetwork !== networkId ||
      lastPage !== page ||
      needsDisplayRender
    ) {
      this.renderPage(entity, inv, snapshot, page, pageCount);
    }

    this.applyPendingItemUpdates(entity, inv, networkId, snapshot);
  }

  /**
   * Mirrors open/closed UI state into a block permutation so JSON tick speed
   * can switch between open and closed intervals.
   *
   * @param {import("@minecraft/server").Block} block Terminal block.
   * @param {boolean} hasOpenUI Whether a player currently has this UI open.
   */
  syncOpenTickState(block, hasOpenUI) {
    if (!this.uiOpenState || !block?.permutation) return;

    const isOpen = block.permutation.getState(this.uiOpenState) === true;
    if (isOpen === hasOpenUI) return;

    try {
      block.setPermutation(block.permutation.withState(this.uiOpenState, hasOpenUI));
    } catch {}
  }

  /**
   * Handles reload and page navigation control slots.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {number} slot Pressed container slot.
   * @returns {string|undefined} Button display name for feedback.
   */
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

  /**
   * Fully renders one terminal page from a network snapshot.
   *
   * This also resets the runtime visible-slot map for this terminal.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {object} snapshot Network snapshot.
   * @param {number} page Page index.
   * @param {number} pageCount Total page count.
   */
  renderPage(entity, inv, snapshot, page, pageCount) {
    const networkId = snapshot.networkId;
    const entries = getSortedItems(networkId, "count");
    const start = page * this.gridSize;
    const pageEntries = entries.slice(start, start + this.gridSize);

    const renderedSlots = new Map();
    const countColumns = this.createEmptyCountColumns();

    for (let i = 0; i < this.gridSize; i++) {
      const slot = this.gridStart + i;
      const entry = pageEntries[i];

      if (!entry) {
        this.setFiller(inv, slot, entity);
        continue;
      }

      const [itemKey, count] = entry;
      const item = this.createDisplayItem(itemKey, count, {
        entity,
        networkId,
        slot,
        itemKey,
      });
      inv.setItem(slot, item);
      this.setCountColumnValue(countColumns, i, count);
      renderedSlots.set(itemKey, slot);
    }

    this.writeCountColumns(inv, countColumns);
    this.renderControls(entity, page, pageCount);
    const renderedSlotsObject = Object.fromEntries(renderedSlots.entries());
    entity.setDynamicProperty("ucds:terminal_rendered_slots", JSON.stringify(renderedSlotsObject));
    entity.setDynamicProperty("ucds:terminal_last_network", networkId);
    entity.setDynamicProperty("ucds:terminal_last_page", page);
    entity.setDynamicProperty("ucds:terminal_last_change_seq", snapshot.changeSeq);
    entity.setDynamicProperty("ucds:terminal_force_render", false);
    setTerminalRenderedSlots(networkId, this.getTerminalId(entity), renderedSlots, {
      page,
      visibleCount: pageEntries.length,
      gridStart: this.gridStart,
      gridSize: this.gridSize,
      knownItemKeys: Object.keys(snapshot.totals ?? {}),
    });
  }

  /**
   * Renders an empty terminal state and clears UI tracking properties.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   */
  renderEmpty(entity, inv) {
    this.clearGrid(inv, entity);
    this.clearCountLabels(inv);
    this.renderControls(entity, 0, 1);
    entity.setDynamicProperty("ucds:terminal_rendered_slots", "{}");
    entity.setDynamicProperty("ucds:terminal_last_network", 0);
    entity.setDynamicProperty("ucds:terminal_last_page", 0);
    entity.setDynamicProperty("ucds:terminal_last_change_seq", -1);
    entity.setDynamicProperty("ucds:terminal_force_render", false);
  }

  /**
   * Rebuilds runtime display state from persisted entity properties after a
   * reload, then refreshes output claim tokens for visible items.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} networkId Linked network id.
   * @param {number} page Current page.
   * @param {object|undefined} displayState Runtime display state.
   * @param {object} snapshot Network snapshot.
   * @returns {boolean} True when runtime display mapping is usable.
   */
  ensureTerminalDisplayMapped(entity, inv, networkId, page, displayState, snapshot) {
    if (!displayState) return false;
    if (displayState.renderedSlots?.size > 0 && displayState.gridSize > 0) return true;

    const lastNetwork = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_network") || 0));
    const lastPage = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_last_page") ?? -1));
    if (lastNetwork !== networkId || lastPage !== page) return false;

    const totals = snapshot?.totals ?? {};
    const hasStoredItems = Object.keys(totals).length > 0;
    const renderedSlots = this.readRenderedSlots(entity);
    const staleSlots = [];
    for (const [itemKey, slot] of [...renderedSlots.entries()]) {
      if (Math.floor(Number(totals[itemKey] ?? 0)) <= 0) {
        staleSlots.push(slot);
        renderedSlots.delete(itemKey);
      }
    }
    for (const slot of staleSlots) {
      this.setFiller(inv, slot, entity);
      this.setCountLabel(inv, slot, 0);
    }
    if (renderedSlots.size === 0 && hasStoredItems) return false;

    const mapped = setTerminalRenderedSlots(networkId, this.getTerminalId(entity), renderedSlots, {
      page,
      visibleCount: renderedSlots.size,
      gridStart: this.gridStart,
      gridSize: this.gridSize,
      knownItemKeys: Object.keys(totals),
    });
    if (mapped && renderedSlots.size > 0) {
      this.refreshRenderedOutputTokens(entity, inv, networkId, renderedSlots, totals);
    }
    return mapped;
  }

  /**
   * Rewrites currently visible items so their output claim ids exist in this
   * session runtime after reload or remapping.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} networkId Linked network id.
   * @param {Map<string, number>} renderedSlots Visible item-key to slot map.
   * @param {Record<string, number>} totals Current network totals.
   */
  refreshRenderedOutputTokens(entity, inv, networkId, renderedSlots, totals) {
    for (const [itemKey, slot] of renderedSlots.entries()) {
      if (slot < this.gridStart || slot > this.gridEnd) continue;

      const count = Math.floor(Number(totals[itemKey] ?? 0));
      if (count <= 0) {
        this.setFiller(inv, slot, entity);
        this.setCountLabel(inv, slot, 0);
        continue;
      }

      inv.setItem(slot, this.createDisplayItem(itemKey, count, {
        entity,
        networkId,
        slot,
        itemKey,
      }));
      this.setCountLabel(inv, slot, count);
    }
  }

  /**
   * Reads the persisted visible item-key to slot map from the entity.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @returns {Map<string, number>} Visible item-key to slot map.
   */
  readRenderedSlots(entity) {
    const raw = entity.getDynamicProperty("ucds:terminal_rendered_slots");
    if (!raw || typeof raw !== "string") return new Map();

    try {
      const object = JSON.parse(raw);
      const slots = new Map();
      for (const [itemKey, slot] of Object.entries(object ?? {})) {
        const normalizedSlot = Math.floor(Number(slot) || 0);
        if (itemKey && normalizedSlot >= this.gridStart && normalizedSlot <= this.gridEnd) {
          slots.set(itemKey, normalizedSlot);
        }
      }
      return slots;
    } catch {
      return new Map();
    }
  }

  /**
   * Renders navigation and reload buttons.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {number} page Current page.
   * @param {number} pageCount Total page count.
   */
  renderControls(entity, page, pageCount) {
    const inv = this.getInventory(entity);
    if (!inv) return;

    this.setButton(inv, this.reloadSlot, "§r§7- Reload");
    this.setButton(inv, this.previousSlot, `§r§7- Previous Page §f${page + 1}/${pageCount}`);
    this.setButton(inv, this.nextSlot, `§r§7- Next Page §f${page + 1}/${pageCount}`);
  }

  /**
   * Inserts items found in burn slots into the linked network.
   *
   * Output-token items are materialized first so moving terminal output into a
   * burn slot still removes the item from storage before reinserting it.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} networkId Linked network id.
   */
  processBurnSlots(entity, inv, networkId) {
    for (const slot of this.burnSlots) {
      const item = inv.getItem(slot);
      if (!item) continue;

      const materialized = materializeOutputItem(item);
      if (this.isUiElementItem(item)) {
        inv.setItem(slot, undefined);
        continue;
      }

      if (materialized.handled && !materialized.item) {
        inv.setItem(slot, undefined);
        continue;
      }

      const inputItem = materialized.item ?? item;
      const itemKey = getItemKey(inputItem);
      if (!itemKey) continue;

      const result = addItem(networkId, itemKey, inputItem.amount, "terminal_burn_slot");
      if (result.inserted <= 0) continue;

      if (result.remaining <= 0) {
        inv.setItem(slot, undefined);
        continue;
      }

      inputItem.amount = result.remaining;
      inv.setItem(slot, inputItem);
    }
  }

  /**
   * Applies direct item amount updates queued for this terminal display.
   *
   * If the runtime asks for a forced reload, a fresh snapshot is rendered after
   * direct updates are consumed.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} networkId Linked network id.
   * @param {object} snapshot Snapshot from the start of this tick.
   */
  applyPendingItemUpdates(entity, inv, networkId, snapshot) {
    const { updates, forceReload } = consumeTerminalItemUpdates(networkId, this.getTerminalId(entity));
    if (updates.length === 0 && !forceReload) return;

    for (const update of updates) {
      if (update.slot < this.gridStart || update.slot > this.gridEnd) continue;

      if (update.amount <= 0) {
        this.setFiller(inv, update.slot, entity);
        this.setCountLabel(inv, update.slot, 0);
        continue;
      }

      inv.setItem(update.slot, this.createDisplayItem(update.itemKey, update.amount, {
        entity,
        networkId,
        slot: update.slot,
        itemKey: update.itemKey,
      }));
      this.setCountLabel(inv, update.slot, update.amount);
    }

    if (forceReload) {
      const latestSnapshot = getNetworkSnapshot(networkId) ?? snapshot;
      const pageCount = this.getPageCount(latestSnapshot);
      const page = this.clampPage(entity, pageCount);
      this.renderPage(entity, inv, latestSnapshot, page, pageCount);
    }
  }

  /**
   * Restores storage filler slots that were picked up by a player and reported
   * through terminal output cleanup watchers.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   */
  restorePendingUiSlots(entity, inv) {
    const slots = consumeUiSlotRestores(this.getTerminalId(entity));
    if (slots.length === 0) return;

    for (const slot of slots) {
      if (slot < this.gridStart || slot > this.gridEnd) continue;

      const current = inv.getItem(slot);
      if (current && current.typeId !== this.fillerId) continue;

      this.setFiller(inv, slot, entity);
    }
  }

  /**
   * Reads the linked network id from a terminal entity.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @returns {number} Linked network id, or 0 when unlinked.
   */
  getLinkedNetworkId(entity) {
    return Math.floor(Number(entity?.getDynamicProperty("ucds:network_id") || 0));
  }

  /**
   * Returns the stable runtime id used for terminal display/update maps.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @returns {string} Entity id, or a location fallback.
   */
  getTerminalId(entity) {
    if (!entity) return "";
    if (entity.id) return String(entity.id);

    const location = entity.location ?? {};
    const dimensionId = entity.dimension?.id ?? "unknown";
    return `${dimensionId}:${Math.floor(location.x ?? 0)},${Math.floor(location.y ?? 0)},${Math.floor(location.z ?? 0)}`;
  }

  /**
   * Calculates the page count for a network snapshot.
   *
   * @param {object} snapshot Network snapshot.
   * @returns {number} At least 1 page.
   */
  getPageCount(snapshot) {
    const itemCount = Object.keys(snapshot?.totals ?? {}).length;
    return Math.max(1, Math.ceil(itemCount / this.gridSize));
  }

  /**
   * Clamps and persists the current page index to the valid page range.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @param {number} pageCount Total page count.
   * @returns {number} Clamped page index.
   */
  clampPage(entity, pageCount) {
    const current = Math.floor(Number(entity.getDynamicProperty("ucds:terminal_page") || 0));
    const page = Math.max(0, Math.min(current, Math.max(1, pageCount) - 1));
    if (page !== current) entity.setDynamicProperty("ucds:terminal_page", page);
    return page;
  }

  /**
   * Creates a visible grid item with an output token when context is provided.
   *
   * @param {string} itemKey Stable storage item key.
   * @param {number} count Total amount stored in the network.
   * @param {object} [outputContext] Output token context.
   * @returns {import("@minecraft/server").ItemStack} Display item.
   */
  createDisplayItem(itemKey, count, outputContext) {
    const probe = createItemFromKey(itemKey, 1);
    const maxAmount = Math.max(1, Math.floor(Number(probe.maxAmount) || 64));
    const amount = Math.max(1, Math.min(maxAmount, Math.floor(Number(count) || 1)));
    const item = createItemFromKey(itemKey, amount);

    if (!outputContext?.entity) return item;

    return attachOutputToken(item, {
      terminalId: this.getTerminalId(outputContext.entity),
      networkId: outputContext.networkId,
      slot: outputContext.slot,
      itemKey,
      amount,
      totalCount: Math.max(0, Math.floor(Number(count) || 0)),
    });
  }

  /**
   * Updates one count label row corresponding to a grid slot.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} slot Grid slot.
   * @param {number} count Amount to display.
   */
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

  /**
   * Creates blank count-label columns for a full page render.
   *
   * @returns {string[][]} Column-major count text rows.
   */
  createEmptyCountColumns() {
    return Array.from(
      { length: this.countLabelColumns },
      () => Array(this.countLabelRows).fill(" "),
    );
  }

  /**
   * Writes one count value into the column buffer used by full page rendering.
   *
   * @param {string[][]} columns Count column text buffers.
   * @param {number} relativeSlot Slot index relative to gridStart.
   * @param {number} count Amount to display.
   */
  setCountColumnValue(columns, relativeSlot, count) {
    if (relativeSlot < 0 || relativeSlot >= this.gridSize) return;

    const column = relativeSlot % this.countLabelColumns;
    const row = Math.floor(relativeSlot / this.countLabelColumns);
    if (!columns[column] || row < 0 || row >= this.countLabelRows) return;

    columns[column][row] = count > 1 ? `§r§f${this.formatCount(count)}` : " ";
  }

  /**
   * Writes all count-label columns into their hidden label item slots.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {string[][]} columns Count column text buffers.
   */
  writeCountColumns(inv, columns) {
    for (let column = 0; column < this.countLabelColumns; column++) {
      const label = new ItemStack(this.buttonId, 1);
      label.nameTag = " ";
      label.setLore(columns[column] ?? Array(this.countLabelRows).fill(" "));
      inv.setItem(this.countLabelBaseSlot + column, label);
    }
  }

  /**
   * Formats large counts for compact terminal labels.
   *
   * @param {number} value Raw count.
   * @returns {string} Compact display text.
   */
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

  /**
   * Clears every burn/input slot.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   */
  clearBurnSlots(inv) {
    for (const slot of this.burnSlots) inv.setItem(slot, undefined);
  }

  /**
   * Fills the visible grid with protected storage filler items.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   */
  clearGrid(inv, entity) {
    for (let slot = this.gridStart; slot <= this.gridEnd; slot++) {
      this.setFiller(inv, slot, entity);
    }
  }

  /**
   * Clears the nine count-label item columns.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   */
  clearCountLabels(inv) {
    for (let column = 0; column < this.countLabelColumns; column++) {
      const label = new ItemStack(this.buttonId, 1);
      label.nameTag = " ";
      label.setLore(Array(this.countLabelRows).fill(" "));
      inv.setItem(this.countLabelBaseSlot + column, label);
    }
  }

  /**
   * Places one protected storage filler item in a grid slot.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} slot Grid slot.
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   */
  setFiller(inv, slot, entity) {
    const filler = new ItemStack(this.fillerId, 1);
    filler.nameTag = "§rStorage Slot";
    attachUiSlotToken(filler, {
      terminalId: this.getTerminalId(entity),
      slot,
    });
    inv.setItem(slot, filler);
  }

  /**
   * Places one UI button item.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} slot Button slot.
   * @param {string} nameTag Button display name.
   */
  setButton(inv, slot, nameTag) {
    const item = new ItemStack(this.buttonId, 1);
    item.nameTag = nameTag;
    inv.setItem(slot, item);
  }

  /**
   * Checks whether an item is marked as a UI-only element.
   *
   * @param {import("@minecraft/server").ItemStack|undefined} item Item to test.
   * @returns {boolean} True for UI-only items.
   */
  isUiElementItem(item) {
    if (!item) return false;
    try {
      if (item.hasTag?.(UI_ELEMENT_TAG)) return true;
    } catch {}
    try {
      return item.getTags?.().includes(UI_ELEMENT_TAG) === true;
    } catch {
      return false;
    }
  }

  /**
   * Gets the current display name for one control slot.
   *
   * @param {number} slot Control slot.
   * @param {number} page Current page.
   * @param {number} pageCount Total page count.
   * @returns {string|undefined} Control display name.
   */
  getControlName(slot, page, pageCount) {
    if (slot === this.reloadSlot) return "§r§7- Reload";
    if (slot === this.previousSlot) return `§r§7- Previous Page §f${page + 1}/${pageCount}`;
    if (slot === this.nextSlot) return `§r§7- Next Page §f${page + 1}/${pageCount}`;
    return undefined;
  }

  /**
   * Gets the inventory container from a terminal entity.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal backing entity.
   * @returns {import("@minecraft/server").Container|undefined} Inventory container.
   */
  getInventory(entity) {
    return entity?.getComponent("minecraft:inventory")?.container;
  }
}
