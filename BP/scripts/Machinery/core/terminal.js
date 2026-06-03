import { ItemStack, system } from "@minecraft/server";
import { BasicMachine, Machine } from "DoriosCore/index.js";
import { spawnEntity } from "DoriosCore/utils/entity.js";
import { getNetworkNodes, updateNetworkAround } from "Machinery/storage/network_manager.js";
import {
  addToNetwork,
  purgeItemFromNetwork,
  readNetworkRecord,
  removeFromNetwork,
} from "Machinery/storage/storage_db.js";
import {
  createItemFromKey as createStoredItemFromKey,
  getItemKey as getStoredItemKey,
} from "Machinery/storage/item_key.js";
import {
  applyVirtualLore,
  needsVirtualLoreRewrite,
} from "Machinery/storage/virtual_item_codec.js";
import { createTaggedFiller } from "Machinery/storage/filler_restore.js";
import { syncBlueprintDataAtSlot as syncBlueprintSlotData } from "Machinery/core/blueprint.js";

const DEFAULT_STORAGE_START = 0;
const DEFAULT_STORAGE_END = 224;
const DEFAULT_STORAGE_SLOTS = 225;
const DEFAULT_MAX_PAGES = 27;
const DEFAULT_COUNT_LABEL_BASE_SLOT = 225;
const DEFAULT_COUNT_LABEL_COLUMNS = 9;
const DEFAULT_COUNT_LABEL_ROWS = 25;
const DEFAULT_COUNT_LABEL_ITEM = "utilitycraft:ui_filler";
const DEFAULT_STORAGE_FILLER = "utilitycraft:storage_filler";
const DEFAULT_STORAGE_FILLER_NAME = "§rStorage Slot";
const DEFAULT_LORE_DISPLAY = "§r§7- Count: §f";

/**
 * Shared base class for Digital Storage terminal machines.
 *
 * Terminal variants keep their own behavior in their block files, while this
 * class owns the repeated machine setup, page helpers, virtual item rendering,
 * and network delta handling.
 */
export class Terminal extends BasicMachine {
  /**
   * Creates a lightweight terminal machine wrapper.
   *
   * @param {import("@minecraft/server").Block} block Terminal block.
   * @param {object|number} [settings] Terminal settings or direct base rate.
   */
  constructor(block, settings = {}) {
    const rate =
      typeof settings === "number"
        ? settings
        : settings?.machine?.rate_speed_base ?? 0;
    super(block, rate);
  }

  /**
   * Handles terminal placement, entity spawning, and network refresh.
   *
   * @param {object} e Block placement event.
   * @param {object} settings Block component settings.
   * @param {object} options Terminal spawn options.
   * @param {string} options.entityType Entity identifier to spawn.
   * @param {(entity: import("@minecraft/server").Entity, block: import("@minecraft/server").Block) => void} options.setupEntity Entity setup callback.
   */
  static onPlace(e, settings, { entityType, setupEntity }) {
    const { block } = e;

    system.run(() => {
      const { x, y, z } = block.center();
      const entity = spawnEntity(block, {
        entity: {
          identifier: entityType,
          input_slot: 220
        }
      })
      setupEntity?.(entity, block);
      updateNetworkAround(block);
    });
  }

  /**
   * Runs the regular machine destruction routine.
   *
   * @param {object} e Block break event.
   * @returns {boolean} Whether the machine destruction routine ran.
   */
  static onDestroy(e) {
    return Machine.onDestroy(e);
  }

  /**
   * Resolves the block owned by a terminal entity.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @returns {import("@minecraft/server").Block|undefined} Terminal block.
   */
  static getEntityBlock(entity) {
    if (!entity || !entity.isValid) return undefined;
    const x = entity.getDynamicProperty("target_storage_x");
    const y = entity.getDynamicProperty("target_storage_y");
    const z = entity.getDynamicProperty("target_storage_z");
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof z === "number"
    ) {
      return entity.dimension.getBlock({ x, y, z });
    }
    const location = entity.location;
    return entity.dimension.getBlock({
      x: Math.floor(location.x),
      y: Math.floor(location.y),
      z: Math.floor(location.z),
    });
  }

  /**
   * Checks if any control slot needs its UI item rendered.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number[]} controlSlots Control slot indexes.
   * @returns {boolean} True when controls should be refreshed.
   */
  static controlsNeedRender(inv, controlSlots) {
    return controlSlots.some((slot) => {
      const item = inv.getItem(slot);
      return (
        !item ||
        item.typeId !== "utilitycraft:ui_filler" ||
        !item.nameTag ||
        item.nameTag === " "
      );
    });
  }

  static getPageChangeDelayTicks() {
    const tickSpeed = Math.floor(Number(globalThis.tickSpeed));
    const baseTickSpeed = Number.isFinite(tickSpeed) && tickSpeed > 0 ? tickSpeed : 20;
    return Math.max(1, baseTickSpeed * 2);
  }

  static createUiFiller(entity, slot, nameTag = " ") {
    return createTaggedFiller("utilitycraft:ui_filler", nameTag, entity, slot);
  }

  static createStorageFiller(entity, slot, nameTag = DEFAULT_STORAGE_FILLER_NAME) {
    return createTaggedFiller(DEFAULT_STORAGE_FILLER, nameTag, entity, slot);
  }

  static syncBlueprintDataAtSlot(entity, slot, itemStack) {
    return syncBlueprintSlotData(entity, slot, itemStack);
  }

  /**
   * Checks whether the visible storage grid has an empty or stale filler slot.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {object} [options] Grid options.
   * @param {number} [options.storageStart=0] First storage slot.
   * @param {number} [options.storageEnd=107] Last storage slot.
   * @param {number} [options.countLabelBaseSlot=108] First count label column slot.
   * @param {number} [options.countLabelColumns=9] Label column count.
   * @param {number} [options.countLabelRows=12] Label rows per column.
   * @param {string} [options.fillerId="utilitycraft:storage_filler"] Filler item id.
   * @param {string} [options.fillerName] Filler display name.
   * @returns {boolean} True when the grid should be rendered again.
   */
  static storageGridNeedsRender(
    inv,
    {
      storageStart = DEFAULT_STORAGE_START,
      storageEnd = DEFAULT_STORAGE_END,
      countLabelBaseSlot = DEFAULT_COUNT_LABEL_BASE_SLOT,
      countLabelColumns = DEFAULT_COUNT_LABEL_COLUMNS,
      countLabelRows = DEFAULT_COUNT_LABEL_ROWS,
      fillerId = DEFAULT_STORAGE_FILLER,
      fillerName = DEFAULT_STORAGE_FILLER_NAME,
    } = {},
  ) {
    for (let slot = storageStart; slot <= storageEnd; slot++) {
      const item = inv.getItem(slot);
      if (!item) return true;
      if (item.typeId === fillerId && item.nameTag !== fillerName) return true;
    }

    for (let column = 0; column < countLabelColumns; column++) {
      const labelItem = inv.getItem(countLabelBaseSlot + column);
      if (!labelItem || labelItem.typeId !== DEFAULT_COUNT_LABEL_ITEM) return true;
      if ((labelItem.getLore() ?? []).length < countLabelRows) return true;
    }
    return false;
  }

  /**
   * Keeps reserved UI-only slots occupied so real items can only enter valid slots.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number[]} slots Reserved slot indexes.
   * @param {object} [options] Filler options.
   * @param {string} [options.fillerId="utilitycraft:ui_filler"] Filler item id.
   * @param {string} [options.fillerName=" "] Filler display name.
   * @param {import("@minecraft/server").Entity} [options.entity] Entity that owns the slot.
   * @param {(item: import("@minecraft/server").ItemStack) => void} [options.onBlockedItem] Callback for real items found in reserved slots.
   */
  static repairFillerSlots(
    inv,
    slots,
    {
      fillerId = "utilitycraft:ui_filler",
      fillerName = " ",
      entity,
      onBlockedItem,
    } = {},
  ) {
    for (const slot of slots) {
      const item = inv.getItem(slot);
      if (item && item.typeId === fillerId && item.nameTag === fillerName) {
        continue;
      }
      if (item && item.typeId !== fillerId) {
        onBlockedItem?.(item);
      }
      inv.setItem(slot, createTaggedFiller(fillerId, fillerName, entity, slot));
    }
  }

  /**
   * Checks whether enough ticks passed since the last page change.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {number} [delayTicks] Minimum tick delay.
   * @returns {boolean} True when a new page change is allowed.
   */
  static canChangePage(entity, delayTicks = Terminal.getPageChangeDelayTicks()) {
    const currentTick = system.currentTick ?? 0;
    const lastTick =
      entity.getDynamicProperty("last_page_change_tick") ?? -delayTicks;
    return currentTick - lastTick >= delayTicks;
  }

  /**
   * Stores the current tick as the terminal's last page change.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   */
  static markPageChanged(entity) {
    entity.setDynamicProperty("last_page_change_tick", system.currentTick ?? 0);
  }

  /**
   * Checks whether a terminal is already spreading a full grid render over ticks.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @returns {boolean} True when a chunked render is in progress.
   */
  static isChunkedRenderActive(entity) {
    return !!entity?.getDynamicProperty?.("chunked_render_active");
  }

  /**
   * Starts a chunked render transaction and returns its token.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @returns {number} Render token.
   */
  static beginChunkedRender(entity) {
    const token =
      Math.floor(Number(entity.getDynamicProperty("chunked_render_token") ?? 0)) + 1;
    entity.setDynamicProperty("chunked_render_token", token);
    entity.setDynamicProperty("chunked_render_active", true);
    return token;
  }

  /**
   * Checks whether a chunked render token is still the latest one.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {number} token Render token.
   * @returns {boolean} True when the render can continue.
   */
  static isChunkedRenderCurrent(entity, token) {
    return (
      !!entity &&
      entity.isValid &&
      Math.floor(Number(entity.getDynamicProperty("chunked_render_token") ?? 0)) === token
    );
  }

  /**
   * Finishes a chunked render transaction.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {number} token Render token.
   */
  static finishChunkedRender(entity, token) {
    if (Terminal.isChunkedRenderCurrent(entity, token)) {
      entity.setDynamicProperty("chunked_render_active", false);
    }
  }

  /**
   * Waits between render chunks so a full page render is spread across ticks.
   *
   * @param {number} index Current item index.
   * @param {number} total Total items in this render.
   * @param {number} spreadTicks Number of ticks to spread across.
   */
  static async waitRenderChunk(index, total, spreadTicks) {
    const chunks = Math.max(1, Math.floor(Number(spreadTicks) || 1));
    const chunkSize = Math.max(1, Math.ceil(total / chunks));
    if ((index + 1) % chunkSize === 0 && index + 1 < total) {
      await system.waitTicks(1);
    }
  }

  /**
   * Initializes the shared dynamic properties used by every terminal entity.
   *
   * Variant-specific files should pass only the properties that make that
   * terminal unique, such as crafting preview state or rendered order tracking.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {import("@minecraft/server").Block} block Terminal block.
   * @param {object} options Base setup options.
   * @param {string} options.nameTag Entity display name.
   * @param {string} [options.machineId] Machine identifier.
   * @param {number} [options.page=0] Initial page index.
   * @param {number} [options.pageChangeDelayTicks] Initial page delay offset.
   * @param {Record<string, boolean|number|string>} [options.extraProperties] Additional dynamic properties.
   */
  static setupBaseEntity(
    entity,
    block,
    {
      nameTag,
      machineId,
      page = 0,
      pageChangeDelayTicks = Terminal.getPageChangeDelayTicks(),
      extraProperties = {},
    },
  ) {
    entity.triggerEvent("utilitycraft:setup_inventory");
    entity.nameTag = nameTag;
    if (machineId) entity.setDynamicProperty("machine_id", machineId);
    entity.setDynamicProperty("is_proxy", false);
    entity.setDynamicProperty("proxy_owner", "");
    entity.setDynamicProperty("proxy_key", "");
    entity.setDynamicProperty("page", page);
    entity.setDynamicProperty("last_rendered_page", -1);
    entity.setDynamicProperty("last_rendered_page_count", -1);
    entity.setDynamicProperty("is_processing_click", false);
    entity.setDynamicProperty("extract_quantity", 1);
    entity.setDynamicProperty("sort_mode", "count");
    entity.setDynamicProperty("last_rendered_qty", -1);
    entity.setDynamicProperty("last_rendered_sort", "");
    entity.setDynamicProperty("last_network_state", "");
    entity.setDynamicProperty("last_network_version", 0);
    entity.setDynamicProperty("last_network_change_seq", 0);
    entity.setDynamicProperty("rendered_slot_keys", "{}");
    entity.setDynamicProperty("force_refresh", false);
    entity.setDynamicProperty("last_interaction_tick", 0);
    entity.setDynamicProperty("last_page_change_tick", -pageChangeDelayTicks);
    entity.setDynamicProperty("target_storage_x", block.location.x);
    entity.setDynamicProperty("target_storage_y", block.location.y);
    entity.setDynamicProperty("target_storage_z", block.location.z);
    entity.setDynamicProperty("target_storage_dim", block.dimension.id);

    for (const key in extraProperties) {
      entity.setDynamicProperty(key, extraProperties[key]);
    }
  }

  /**
   * Creates a stable item key from type, lore, damage, enchantments, and dynamic properties.
   *
   * @param {import("@minecraft/server").ItemStack} item Item to identify.
   * @returns {string} Stable item key.
   */
  static getItemKey(item) {
    return getStoredItemKey(item);
  }

  /**
   * Rebuilds an ItemStack from a terminal item key.
   *
   * @param {string} key Item key generated by {@link Terminal.getItemKey}.
   * @param {number} amount Item amount.
   * @returns {import("@minecraft/server").ItemStack} Recreated item stack.
   */
  static createItemFromKey(key, amount) {
    return createStoredItemFromKey(key, amount);
  }

  /**
   * Reads the stored count from a virtual terminal item.
   *
   * @param {import("@minecraft/server").ItemStack} item Item to inspect.
   * @returns {number} Stored count, or -1 for a non-virtual item.
   */
  static getStoredCount(item) {
    if (!item) return 0;
    const lore = item.getLore();
    if (!lore || lore.length === 0) return -1;
    const loreLine = lore.find((line) => line.includes("Count"));
    if (!loreLine) return -1;
    const match = loreLine.replace(/§./g, "").match(/\d+/g);
    return match ? parseInt(match[match.length - 1]) : 1;
  }

  /**
   * Formats large item counts for compact UI labels.
   *
   * Values under 1000 stay exact. At 1000 and above the label uses one
   * decimal place with k, M, or B suffixes.
   *
   * @param {number} value Raw item count.
   * @returns {string} Compact item count.
   */
  static formatCountLabel(value) {
    const amount = Math.max(0, Math.floor(Number(value) || 0));
    if (amount >= 1000000000) return `${(amount / 1000000000).toFixed(1)}B`;
    if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
    return amount.toString();
  }

  /**
   * Returns an item to a nearby player, or drops it near the terminal.
   *
   * @param {import("@minecraft/server").Block} block Terminal block.
   * @param {import("@minecraft/server").ItemStack} itemStack Item to return.
   */
  static returnToPlayer(block, itemStack) {
    if (!itemStack) return;
    try {
      const players = block.dimension.getPlayers({
        location: block.location,
        maxDistance: 5,
      });
      if (players.length > 0) {
        const player = players[0];
        const pInv = (
          player.getComponent("inventory") ||
          player.getComponent("minecraft:inventory")
        )?.container;
        if (pInv) {
          const overflow = pInv.addItem(itemStack);
          if (overflow) block.dimension.spawnItem(overflow, player.location);
          return;
        }
      }
      block.dimension.spawnItem(itemStack, block.center());
    } catch (e) {
      console.warn("Terminal entity was removed before item could be returned.");
    }
  }

  /**
   * Gets all network nodes reachable from a terminal block.
   *
   * @param {import("@minecraft/server").Block} startBlock Terminal block.
   * @returns {object} Network node snapshot.
   */
  static getConnectedInventories(startBlock) {
    return getNetworkNodes(startBlock);
  }

  /**
   * Counts how many pages are needed for a network total map.
   *
   * @param {Record<string, number>} networkTotals Network totals by item key.
   * @param {number} [storageSlots=110] Slots per page.
   * @param {number} [maxPages=3] Maximum page count.
   * @returns {number} Clamped page count.
   */
  static getPageCountFromTotals(
    networkTotals,
    storageSlots = DEFAULT_STORAGE_SLOTS,
    maxPages = DEFAULT_MAX_PAGES,
  ) {
    const usedPages = Math.ceil(Object.keys(networkTotals).length / storageSlots);
    return Math.max(1, Math.min(maxPages, usedPages || 1));
  }

  /**
   * Counts pages for the network attached to an entity.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {number} [storageSlots=110] Slots per page.
   * @param {number} [maxPages=3] Maximum page count.
   * @returns {number} Clamped page count.
   */
  static getPageCountForEntity(
    entity,
    storageSlots = DEFAULT_STORAGE_SLOTS,
    maxPages = DEFAULT_MAX_PAGES,
  ) {
    const block = Terminal.getEntityBlock(entity);
    if (!block) return maxPages;
    const nodes = Terminal.getConnectedInventories(block);
    const network = readNetworkRecord(nodes.networkId);
    return Terminal.getPageCountFromTotals(
      network?.totals ?? {},
      storageSlots,
      maxPages,
    );
  }

  /**
   * Clamps the terminal page property and marks the UI stale if it changed.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {number} pageCount Current page count.
   * @returns {number} Clamped page index.
   */
  static clampPage(entity, pageCount) {
    const currentPage = entity.getDynamicProperty("page") ?? 0;
    const clampedPage = Math.max(0, Math.min(currentPage, pageCount - 1));
    if (clampedPage !== currentPage) {
      entity.setDynamicProperty("page", clampedPage);
      entity.setDynamicProperty("last_rendered_page", -1);
      entity.setDynamicProperty("force_refresh", true);
    }
    return clampedPage;
  }

  /**
   * Reads an item count from the network DB.
   *
   * @param {object} nodes Network node snapshot.
   * @param {string} itemKey Item key.
   * @returns {number} Stored amount.
   */
  static countItemsInNetwork(nodes, itemKey) {
    const network = readNetworkRecord(nodes.networkId);
    return Number(network?.totals?.[itemKey] ?? 0);
  }

  /**
   * Removes items from the network DB.
   *
   * @param {object} nodes Network node snapshot.
   * @param {string} itemKey Item key.
   * @param {number} amount Requested amount.
   * @returns {number} Removed amount.
   */
  static removeItemsFromNetwork(nodes, itemKey, amount) {
    return removeFromNetwork(nodes.networkId, itemKey, amount);
  }

  /**
   * Adds a real item to the network DB.
   *
   * @param {object} nodes Network node snapshot.
   * @param {import("@minecraft/server").ItemStack} itemToAdd Item to store.
   * @param {(item: import("@minecraft/server").ItemStack) => boolean} isStorageCell Cell guard.
   * @returns {number} Stored amount.
   */
  static addItemsToNetwork(nodes, itemToAdd, isStorageCell) {
    if (isStorageCell?.(itemToAdd)) return itemToAdd.amount;
    return addToNetwork(
      nodes.networkId,
      Terminal.getItemKey(itemToAdd),
      itemToAdd.amount,
    );
  }

  /**
   * Reads the current page item-to-slot map from entity dynamic properties.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @returns {Record<string, number>} Item key to slot map.
   */
  static getRenderedSlotMap(entity) {
    const raw = entity.getDynamicProperty("rendered_slot_keys");
    if (typeof raw !== "string" || raw.length === 0) return {};

    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Stores the current page item-to-slot map on the entity.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {string[]} pageSlice Item keys shown on this page.
   * @param {number} [storageStart=0] First storage slot.
   */
  static setRenderedSlotMap(
    entity,
    pageSlice,
    storageStart = DEFAULT_STORAGE_START,
  ) {
    const map = {};
    for (let i = 0; i < pageSlice.length; i++) {
      map[pageSlice[i]] = storageStart + i;
    }
    entity.setDynamicProperty("rendered_slot_keys", JSON.stringify(map));
  }

  /**
   * Updates the count label paired with a storage slot.
   *
   * @param {Terminal|BasicMachine} machine Terminal machine wrapper.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {number} slot Storage slot.
   * @param {object} [options] Rendering options.
   * @param {number} [options.countLabelBaseSlot=108] First label column slot.
   * @param {number} [options.countLabelColumns=9] Label column count.
   * @param {number} [options.countLabelRows=12] Label rows per column.
   * @param {string} [options.fillerId="utilitycraft:storage_filler"] Filler item id.
   */
  static setCountLabel(
    machine,
    inv,
    slot,
    {
      countLabelBaseSlot = DEFAULT_COUNT_LABEL_BASE_SLOT,
      countLabelColumns = DEFAULT_COUNT_LABEL_COLUMNS,
      countLabelRows = DEFAULT_COUNT_LABEL_ROWS,
      fillerId = DEFAULT_STORAGE_FILLER,
    } = {},
  ) {
    const item = inv.getItem(slot);
    let labelText = " ";
    if (item && item.typeId !== fillerId) {
      const count = Terminal.getStoredCount(item);
      const valStr = Terminal.formatCountLabel(count !== -1 ? count : item.amount);
      if (valStr !== "1") {
        labelText = `§r§f${valStr}`;
      }
    }
    const relativeSlot = slot - DEFAULT_STORAGE_START;
    if (relativeSlot < 0) return;

    const column = relativeSlot % countLabelColumns;
    const row = Math.floor(relativeSlot / countLabelColumns);
    if (column < 0 || column >= countLabelColumns || row < 0 || row >= countLabelRows) return;

    const labelSlot = countLabelBaseSlot + column;
    let labelItem = inv.getItem(labelSlot);
    if (!labelItem || labelItem.typeId !== DEFAULT_COUNT_LABEL_ITEM) {
      labelItem = new ItemStack(DEFAULT_COUNT_LABEL_ITEM, 1);
    }
    if (labelItem.nameTag !== " ") labelItem.nameTag = " ";

    const lore = labelItem.getLore() ?? [];
    while (lore.length < countLabelRows) lore.push(" ");
    if (lore[row] === labelText) return;

    lore[row] = labelText;
    labelItem.setLore(lore.slice(0, countLabelRows));
    inv.setItem(labelSlot, labelItem);
  }

  /**
   * Finds a rendered virtual item currently visible in a page.
   *
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {string} itemKey Item key to find.
   * @param {object} [options] Search options.
   * @returns {number} Visible slot, or -1.
   */
  static findVisibleVirtualSlot(
    inv,
    itemKey,
    {
      storageStart = DEFAULT_STORAGE_START,
      storageEnd = DEFAULT_STORAGE_END,
      fillerId = DEFAULT_STORAGE_FILLER,
    } = {},
  ) {
    for (let slot = storageStart; slot <= storageEnd; slot++) {
      const item = inv.getItem(slot);
      if (!item || item.typeId === fillerId) continue;
      if (Terminal.getStoredCount(item) === -1) continue;
      if (Terminal.getItemKey(item) === itemKey) return slot;
    }

    return -1;
  }

  /**
   * Updates one visible virtual item without re-rendering the full page.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {Terminal|BasicMachine} machine Terminal machine wrapper.
   * @param {number|string} networkId Network id for hidden lore.
   * @param {string} itemKey Item key to update.
   * @param {number} count New network count.
   * @param {number} currentQty Current extract quantity.
   * @param {object} [options] Render options.
   * @returns {boolean} True when the delta was handled.
   */
  static updateVisibleVirtualItem(
    entity,
    inv,
    machine,
    networkId,
    itemKey,
    count,
    currentQty,
    {
      storageStart = DEFAULT_STORAGE_START,
      storageEnd = DEFAULT_STORAGE_END,
      countLabelBaseSlot = DEFAULT_COUNT_LABEL_BASE_SLOT,
      loreDisplay = DEFAULT_LORE_DISPLAY,
      fillerId = DEFAULT_STORAGE_FILLER,
      fillerName = DEFAULT_STORAGE_FILLER_NAME,
    } = {},
  ) {
    const renderedSlots = Terminal.getRenderedSlotMap(entity);
    const mappedSlot = renderedSlots[itemKey];
    const slot =
      Number.isInteger(mappedSlot) &&
        mappedSlot >= storageStart &&
        mappedSlot <= storageEnd
        ? mappedSlot
        : Terminal.findVisibleVirtualSlot(inv, itemKey, {
          storageStart,
          storageEnd,
          fillerId,
        });
    if (slot < 0) return true;
    if (count <= 0) {
      inv.setItem(slot, createTaggedFiller(fillerId, fillerName, entity, slot));
      Terminal.setCountLabel(machine, inv, slot, {
        countLabelBaseSlot,
        fillerId,
      });
      delete renderedSlots[itemKey];
      entity.setDynamicProperty(
        "rendered_slot_keys",
        JSON.stringify(renderedSlots),
      );
      return true;
    }

    try {
      const virtualItemTest = Terminal.createItemFromKey(itemKey, 1);
      const maxStack = virtualItemTest.maxAmount ?? 64;
      const renderAmount = Math.min(currentQty, count, maxStack);
      const virtualItem = Terminal.createItemFromKey(itemKey, renderAmount);
      const currentLore = virtualItem.getLore() || [];
      applyVirtualLore(
        virtualItem,
        [...currentLore, `${loreDisplay}${count}`],
        networkId,
        itemKey,
      );
      inv.setItem(slot, virtualItem);
      Terminal.syncBlueprintDataAtSlot(entity, slot, virtualItem);
    } catch (error) {
      purgeItemFromNetwork(networkId, itemKey, "render_error");
      try {
        inv.setItem(slot, createTaggedFiller(fillerId, fillerName, entity, slot));
      } catch { }
      delete renderedSlots[itemKey];
      entity.setDynamicProperty("rendered_slot_keys", JSON.stringify(renderedSlots));
      entity.setDynamicProperty("force_refresh", true);
      console.warn(`Digital Storage removed an item that could not render: ${itemKey}`);
      return true;
    }
    Terminal.setCountLabel(machine, inv, slot, {
      countLabelBaseSlot,
      fillerId,
    });
    return true;
  }

  /**
   * Renders a full virtual storage grid across multiple ticks.
   *
   * This is used only for reload-all cases. Small network deltas should keep
   * using direct single-slot updates.
   *
   * @param {object} options Render options.
   * @returns {Promise<boolean>} True when the render completed.
   */
  static async renderVirtualGridChunked({
    entity,
    inv,
    machine,
    networkId,
    hasNetwork,
    networkTotals,
    pageSlice,
    currentQty,
    storageStart = DEFAULT_STORAGE_START,
    storageSlots = DEFAULT_STORAGE_SLOTS,
    countLabelBaseSlot = DEFAULT_COUNT_LABEL_BASE_SLOT,
    loreDisplay = DEFAULT_LORE_DISPLAY,
    fillerId = DEFAULT_STORAGE_FILLER,
    fillerName = DEFAULT_STORAGE_FILLER_NAME,
    spreadTicks = Terminal.getPageChangeDelayTicks(),
  }) {
    if (Terminal.isChunkedRenderActive(entity)) {
      entity.setDynamicProperty("force_refresh", true);
      return false;
    }
    const token = Terminal.beginChunkedRender(entity);
    try {
      const safeTotals = networkTotals ?? {};
      const safePageSlice = Array.isArray(pageSlice) ? pageSlice : [];
      const renderedSlots = {};
      let pageIndex = 0;

      for (let i = 0; i < storageSlots; i++) {
        if (!Terminal.isChunkedRenderCurrent(entity, token)) return false;

        const currentSlot = storageStart + i;
        const existingItem = inv.getItem(currentSlot);
        if (
          existingItem &&
          existingItem.typeId !== fillerId &&
          Terminal.getStoredCount(existingItem) === -1
        ) {
          Terminal.setCountLabel(machine, inv, currentSlot, {
            countLabelBaseSlot,
            fillerId,
          });
          await Terminal.waitRenderChunk(i, storageSlots, spreadTicks);
          continue;
        }

        let renderedKey;
        while (hasNetwork && pageIndex < safePageSlice.length && !renderedKey) {
          const key = safePageSlice[pageIndex++];
          try {
            const virtualItemTest = Terminal.createItemFromKey(key, 1);
            const maxStack = virtualItemTest.maxAmount ?? 64;
            const renderAmount = Math.min(currentQty, safeTotals[key] || 0, maxStack);
            const virtualItem = Terminal.createItemFromKey(key, renderAmount);
            const currentLore = virtualItem.getLore() || [];
            applyVirtualLore(
              virtualItem,
              [...currentLore, `${loreDisplay}${safeTotals[key]}`],
              networkId,
              key,
            );
            const existingKey = existingItem ? Terminal.getItemKey(existingItem) : null;
            if (
              !existingItem ||
              existingKey !== key ||
              Terminal.getStoredCount(existingItem) !== safeTotals[key] ||
              existingItem.amount !== renderAmount ||
              needsVirtualLoreRewrite(existingItem)
            ) {
              inv.setItem(currentSlot, virtualItem);
            }
            Terminal.syncBlueprintDataAtSlot(entity, currentSlot, virtualItem);
            renderedKey = key;
            renderedSlots[key] = currentSlot;
          } catch (error) {
            purgeItemFromNetwork(networkId, key, "render_error");
            console.warn(`Digital Storage skipped an item that could not render: ${key}`);
          }
        }

        if (!renderedKey && (
          !existingItem ||
          existingItem.typeId !== fillerId ||
          existingItem.nameTag !== fillerName
        )) {
          inv.setItem(
            currentSlot,
            createTaggedFiller(fillerId, fillerName, entity, currentSlot),
          );
        }

        Terminal.setCountLabel(machine, inv, currentSlot, {
          countLabelBaseSlot,
          fillerId,
        });
        await Terminal.waitRenderChunk(i, storageSlots, spreadTicks);
      }

      entity.setDynamicProperty("rendered_slot_keys", JSON.stringify(renderedSlots));
      return true;
    } finally {
      Terminal.finishChunkedRender(entity, token);
    }
  }

  /**
   * Checks whether an item key is represented in the current rendered page.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {string} itemKey Item key.
   * @param {object} [options] Search options.
   * @returns {boolean} True when the item is visible.
   */
  static isRenderedItemVisible(entity, inv, itemKey, options = {}) {
    const {
      storageStart = DEFAULT_STORAGE_START,
      storageEnd = DEFAULT_STORAGE_END,
    } = options;
    const renderedSlots = Terminal.getRenderedSlotMap(entity);
    const mappedSlot = renderedSlots[itemKey];
    if (
      Number.isInteger(mappedSlot) &&
      mappedSlot >= storageStart &&
      mappedSlot <= storageEnd
    ) {
      return true;
    }

    return Terminal.findVisibleVirtualSlot(inv, itemKey, options) >= 0;
  }

  /**
   * Applies queued network DB changes to the visible page.
   *
   * Returns `"reload"` when the page needs a full render, `false` when the
   * delta stream cannot be trusted, and `true` when changes were handled.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {import("@minecraft/server").Container} inv Terminal inventory.
   * @param {Terminal|BasicMachine} machine Terminal machine wrapper.
   * @param {object} networkRecord Network DB record.
   * @param {number|string} networkId Network id.
   * @param {number} currentQty Current extract quantity.
   * @param {object} [options] Render options.
   * @returns {boolean|string} Delta result.
   */
  static applyNetworkDeltas(
    entity,
    inv,
    machine,
    networkRecord,
    networkId,
    currentQty,
    options = {},
  ) {
    const changes = Array.isArray(networkRecord?.changes)
      ? networkRecord.changes
      : [];
    const changeSeq = Math.floor(Number(networkRecord?.changeSeq ?? 0));
    const lastSeen = Math.floor(
      Number(entity.getDynamicProperty("last_network_change_seq") ?? 0),
    );
    if (changeSeq <= lastSeen) return true;
    if (changes.length === 0) return false;

    const pending = changes.filter((change) => change.seq > lastSeen);
    if (pending.length === 0) {
      entity.setDynamicProperty("last_network_change_seq", changeSeq);
      return true;
    }
    if (pending[0].seq > lastSeen + 1 && lastSeen !== 0) return false;

    for (const change of pending) {
      if (change?.reloadAll) return "reload";
      if (
        Math.floor(Number(change?.after ?? 0)) <= 0 &&
        Terminal.isRenderedItemVisible(entity, inv, change.itemKey, options)
      ) {
        return "reload";
      }
      const handled = Terminal.updateVisibleVirtualItem(
        entity,
        inv,
        machine,
        networkId,
        change.itemKey,
        change.after,
        currentQty,
        options,
      );
      if (!handled) return false;
    }

    entity.setDynamicProperty("last_network_change_seq", changeSeq);
    return true;
  }

  /**
   * Persists the network state observed by the terminal.
   *
   * @param {import("@minecraft/server").Entity} entity Terminal entity.
   * @param {object} networkRecord Network DB record.
   * @param {Record<string, number>} networkTotals Network totals.
   * @param {number} networkVersion Network version.
   */
  static syncNetworkState(entity, networkRecord, networkTotals, networkVersion) {
    entity.setDynamicProperty("last_network_version", networkVersion);
    entity.setDynamicProperty(
      "last_network_state",
      JSON.stringify(networkTotals ?? {}),
    );
    entity.setDynamicProperty(
      "last_network_change_seq",
      Math.floor(Number(networkRecord?.changeSeq ?? 0)),
    );
  }
}
