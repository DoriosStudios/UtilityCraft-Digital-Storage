import { StructureSaveMode, system, world } from "@minecraft/server";

export const OPAQUE_ITEM_KEY_PREFIX = "ucds:vault:";

const VAULT_ENTITY_TYPE = "utilitycraft:storage_vault";
const PAGE_ID_PROPERTY = "ucds:vault_page_id";
const PAGE_COUNT_PROPERTY = "ucds:vault_page_count";
const ACTIVE_BACKUP_PROPERTY = "ucds:vault_backup_active";
const BACKUP_IDS = ["utilitycraft:ds_vault_backup_a", "utilitycraft:ds_vault_backup_b"];
const PRIMARY_LOCATION = { x: 2, y: -62, z: 2 };
const RECOVERY_LOCATION = { x: 4, y: -62, z: 4 };
const PAGE_SIZE = 256;
const BACKUP_INTERVAL_TICKS = 20 * 60 * 5;

/** @type {Map<number, import("@minecraft/server").Entity>} */
const livePages = new Map();
const pageSlotHints = new Map();
const fullPages = new Set();
/** @type {Map<number, Set<number> | undefined>} */
const recoveryRequests = new Map();
let backupRunId;
let recoveryRunning = false;

function getDimension() {
  return world.getDimension("overworld");
}

function getPageId(entity) {
  const value = Math.floor(Number(entity?.getDynamicProperty?.(PAGE_ID_PROPERTY)) || 0);
  return value > 0 ? value : 0;
}

function getExpectedPageCount() {
  return Math.max(0, Math.floor(Number(world.getDynamicProperty(PAGE_COUNT_PROPERTY)) || 0));
}

function getEntitiesAt(location) {
  try {
    return getDimension().getEntities({
      type: VAULT_ENTITY_TYPE,
      location,
      maxDistance: 1,
    });
  } catch {
    return [];
  }
}

function getContainer(entity) {
  if (!entity?.isValid) return undefined;
  return entity.getComponent("minecraft:inventory")?.container;
}

function refreshLivePages() {
  const previousPages = new Map(livePages);
  livePages.clear();
  let highestPageId = 0;

  for (const entity of getEntitiesAt(PRIMARY_LOCATION)) {
    const pageId = getPageId(entity);
    if (!pageId || livePages.has(pageId)) continue;
    livePages.set(pageId, entity);
    if (previousPages.get(pageId)?.id !== entity.id) {
      pageSlotHints.delete(pageId);
      fullPages.delete(pageId);
    }
    highestPageId = Math.max(highestPageId, pageId);
  }

  for (const pageId of [...pageSlotHints.keys()]) {
    if (!livePages.has(pageId)) pageSlotHints.delete(pageId);
  }
  for (const pageId of [...fullPages]) {
    if (!livePages.has(pageId)) fullPages.delete(pageId);
  }

  if (highestPageId > getExpectedPageCount()) {
    world.setDynamicProperty(PAGE_COUNT_PROPERTY, highestPageId);
  }
  return livePages;
}

function getLivePage(pageId) {
  const cached = livePages.get(pageId);
  if (cached?.isValid) return cached;
  refreshLivePages();
  return livePages.get(pageId);
}

function spawnPage(pageId, { updateCount = false } = {}) {
  const id = Math.max(1, Math.floor(Number(pageId) || 1));
  try {
    const entity = getDimension().spawnEntity(VAULT_ENTITY_TYPE, PRIMARY_LOCATION);
    entity.setDynamicProperty(PAGE_ID_PROPERTY, id);
    livePages.set(id, entity);
    pageSlotHints.set(id, 0);
    fullPages.delete(id);
    if (updateCount) world.setDynamicProperty(PAGE_COUNT_PROPERTY, id);
    return entity;
  } catch (error) {
    console.warn(`[DigitalStorage] Unable to create vault page ${id}: ${error?.message ?? error}`);
    return undefined;
  }
}

function findEmptySlot(pageId, container) {
  if (!container || fullPages.has(pageId)) return -1;
  const size = Math.min(PAGE_SIZE, container.size);
  const start = Math.max(0, Math.min(size - 1, pageSlotHints.get(pageId) ?? 0));
  for (let offset = 0; offset < size; offset++) {
    const slot = (start + offset) % size;
    if (container.getItem(slot)) continue;
    pageSlotHints.set(pageId, (slot + 1) % size);
    return slot;
  }
  fullPages.add(pageId);
  return -1;
}

function getMissingPageIds() {
  refreshLivePages();
  const missing = [];
  for (let pageId = 1; pageId <= getExpectedPageCount(); pageId++) {
    if (!livePages.has(pageId)) missing.push(pageId);
  }
  return missing;
}

function cleanupRecoveryEntities() {
  for (const entity of getEntitiesAt(RECOVERY_LOCATION)) {
    try {
      entity.remove();
    } catch {}
  }
}

function getBackupCandidates() {
  const active = world.getDynamicProperty(ACTIVE_BACKUP_PROPERTY) === "b" ? 1 : 0;
  return active === 0 ? [BACKUP_IDS[0], BACKUP_IDS[1]] : [BACKUP_IDS[1], BACKUP_IDS[0]];
}

function copyRecoveredPage(source, pageId, requestedSlots) {
  const sourceContainer = getContainer(source);
  if (!sourceContainer) return false;

  let destination = getLivePage(pageId);
  if (!destination) destination = spawnPage(pageId);
  const destinationContainer = getContainer(destination);
  if (!destinationContainer) return false;

  if (!requestedSlots) {
    const size = Math.min(PAGE_SIZE, sourceContainer.size, destinationContainer.size);
    for (let slot = 0; slot < size; slot++) {
      destinationContainer.setItem(slot, sourceContainer.getItem(slot));
    }
    pageSlotHints.delete(pageId);
    fullPages.delete(pageId);
    return true;
  }

  let restored = false;
  for (const slot of requestedSlots) {
    if (destinationContainer.getItem(slot)) {
      restored = true;
      continue;
    }
    const item = sourceContainer.getItem(slot);
    if (!item) continue;
    destinationContainer.setItem(slot, item);
    restored = true;
  }
  pageSlotHints.delete(pageId);
  fullPages.delete(pageId);
  return restored;
}

function finishRecovery() {
  cleanupRecoveryEntities();
  recoveryRequests.clear();
  recoveryRunning = false;
}

function tryRecoveryBackup(candidates, index = 0) {
  if (index >= candidates.length || recoveryRequests.size === 0) {
    finishRecovery();
    return;
  }

  const backupId = candidates[index];
  let structure;
  try {
    structure = world.structureManager.get(backupId);
  } catch {}
  if (!structure) {
    tryRecoveryBackup(candidates, index + 1);
    return;
  }

  cleanupRecoveryEntities();
  try {
    world.structureManager.place(structure, getDimension(), RECOVERY_LOCATION, {
      includeBlocks: false,
      includeEntities: true,
    });
  } catch (error) {
    console.warn(`[DigitalStorage] Unable to place vault backup ${backupId}: ${error?.message ?? error}`);
    tryRecoveryBackup(candidates, index + 1);
    return;
  }

  system.run(() => {
    const recoveredPages = new Map();
    for (const entity of getEntitiesAt(RECOVERY_LOCATION)) {
      const pageId = getPageId(entity);
      if (pageId && !recoveredPages.has(pageId)) recoveredPages.set(pageId, entity);
    }

    for (const [pageId, requestedSlots] of [...recoveryRequests.entries()]) {
      const source = recoveredPages.get(pageId);
      if (!source) continue;
      if (copyRecoveredPage(source, pageId, requestedSlots)) recoveryRequests.delete(pageId);
    }

    cleanupRecoveryEntities();
    refreshLivePages();
    if (recoveryRequests.size > 0) tryRecoveryBackup(candidates, index + 1);
    else finishRecovery();
  });
}

function startRecovery() {
  if (recoveryRunning || recoveryRequests.size === 0) return;
  recoveryRunning = true;
  system.run(() => tryRecoveryBackup(getBackupCandidates()));
}

function requestPageRecovery(pageId, slot) {
  const id = Math.max(1, Math.floor(Number(pageId) || 1));
  if (slot === undefined) {
    recoveryRequests.set(id, undefined);
  } else if (recoveryRequests.get(id) !== undefined || !recoveryRequests.has(id)) {
    const slots = recoveryRequests.get(id) ?? new Set();
    slots.add(Math.max(0, Math.min(PAGE_SIZE - 1, Math.floor(Number(slot) || 0))));
    recoveryRequests.set(id, slots);
  }
  startRecovery();
}

function saveVaultBackup() {
  if (recoveryRunning) return false;

  const expected = getExpectedPageCount();
  if (expected <= 0) return false;

  const missing = getMissingPageIds();
  if (missing.length > 0) {
    for (const pageId of missing) requestPageRecovery(pageId);
    return false;
  }

  const current = world.getDynamicProperty(ACTIVE_BACKUP_PROPERTY) === "b" ? 1 : 0;
  const next = current === 0 ? 1 : 0;
  const backupId = BACKUP_IDS[next];

  try {
    if (world.structureManager.get(backupId)) world.structureManager.delete(backupId);
    world.structureManager.createFromWorld(
      backupId,
      getDimension(),
      PRIMARY_LOCATION,
      PRIMARY_LOCATION,
      {
        includeBlocks: false,
        includeEntities: true,
        saveMode: StructureSaveMode.World,
      },
    );
    world.setDynamicProperty(ACTIVE_BACKUP_PROPERTY, next === 0 ? "a" : "b");
    return true;
  } catch (error) {
    console.warn(`[DigitalStorage] Unable to save vault backup ${backupId}: ${error?.message ?? error}`);
    return false;
  }
}

/** Returns true for ItemStacks that must be preserved physically. */
export function isOpaqueItem(item) {
  return !!item && Math.max(1, Math.floor(Number(item.maxAmount) || 1)) === 1;
}

/** Returns true for a physical vault reference key. */
export function isOpaqueItemKey(itemKey) {
  return String(itemKey ?? "").startsWith(OPAQUE_ITEM_KEY_PREFIX);
}

/** Parses a physical vault reference. */
export function parseOpaqueItemKey(itemKey) {
  const match = /^ucds:vault:(\d+):(\d+)$/.exec(String(itemKey ?? ""));
  if (!match) return undefined;
  const pageId = Number(match[1]);
  const slot = Number(match[2]);
  if (!Number.isSafeInteger(pageId) || pageId <= 0 || !Number.isInteger(slot) || slot < 0 || slot >= PAGE_SIZE) {
    return undefined;
  }
  return { pageId, slot };
}

/** Stores one native ItemStack without serializing its data. */
export function storeOpaqueItem(item) {
  if (!isOpaqueItem(item)) return { stored: false, reason: "not_opaque" };

  const missing = getMissingPageIds();
  if (missing.length > 0) {
    for (const pageId of missing) requestPageRecovery(pageId);
    return { stored: false, reason: "vault_missing" };
  }

  let pageId = 0;
  let entity;
  let slot = -1;
  const expected = getExpectedPageCount();

  for (let id = 1; id <= expected; id++) {
    const candidate = getLivePage(id);
    const candidateSlot = findEmptySlot(id, getContainer(candidate));
    if (candidateSlot < 0) continue;
    pageId = id;
    entity = candidate;
    slot = candidateSlot;
    break;
  }

  if (!entity) {
    pageId = expected + 1;
    entity = spawnPage(pageId, { updateCount: true });
    slot = findEmptySlot(pageId, getContainer(entity));
  }

  const container = getContainer(entity);
  if (!container || slot < 0) return { stored: false, reason: "vault_unavailable" };

  try {
    container.setItem(slot, item);
    return {
      stored: true,
      itemKey: `${OPAQUE_ITEM_KEY_PREFIX}${pageId}:${slot}`,
      pageId,
      slot,
    };
  } catch {
    return { stored: false, reason: "vault_unavailable" };
  }
}

/** Reads a clone of an opaque item for terminal display. */
export function peekOpaqueItem(itemKey) {
  const ref = parseOpaqueItemKey(itemKey);
  if (!ref) return { found: false, reason: "invalid_vault_key" };

  const entity = getLivePage(ref.pageId);
  if (!entity) {
    requestPageRecovery(ref.pageId);
    return { found: false, reason: "vault_missing" };
  }

  const item = getContainer(entity)?.getItem(ref.slot);
  if (!item) {
    requestPageRecovery(ref.pageId, ref.slot);
    return { found: false, reason: "vault_missing" };
  }
  return { found: true, item };
}

/** Removes and returns an opaque ItemStack before its logical key is decremented. */
export function takeOpaqueItem(itemKey) {
  const ref = parseOpaqueItemKey(itemKey);
  if (!ref) return { taken: false, reason: "invalid_vault_key" };

  const entity = getLivePage(ref.pageId);
  if (!entity) {
    requestPageRecovery(ref.pageId);
    return { taken: false, reason: "vault_missing" };
  }

  const container = getContainer(entity);
  const item = container?.getItem(ref.slot);
  if (!container || !item) {
    requestPageRecovery(ref.pageId, ref.slot);
    return { taken: false, reason: "vault_missing" };
  }

  container.setItem(ref.slot, undefined);
  pageSlotHints.set(ref.pageId, ref.slot);
  fullPages.delete(ref.pageId);
  return { taken: true, item };
}

/** Clears a just-created reference when its logical insertion could not commit. */
export function discardOpaqueItem(itemKey) {
  const ref = parseOpaqueItemKey(itemKey);
  if (!ref) return false;
  const container = getContainer(getLivePage(ref.pageId));
  if (!container) return false;
  container.setItem(ref.slot, undefined);
  pageSlotHints.set(ref.pageId, ref.slot);
  fullPages.delete(ref.pageId);
  return true;
}

/** Initializes page discovery, missing-page recovery and the lightweight backup timer. */
export function initializeOpaqueVaults() {
  refreshLivePages();
  for (const pageId of getMissingPageIds()) requestPageRecovery(pageId);
  if (backupRunId !== undefined) return;
  backupRunId = system.runInterval(saveVaultBackup, BACKUP_INTERVAL_TICKS);
}
