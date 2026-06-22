import { EnchantmentTypes, ItemStack, world } from "@minecraft/server";

/**
 * Item identity registry for Digital Storage V2.
 *
 * Storage cells store counts by stable item key. Simple items use their type id
 * directly. Items with extra identity data use `ucds:item:<definitionId>` and
 * the canonical definition is persisted once in `ucds:itemdef:<definitionId>`.
 */

const ITEM_KEY_PREFIX = "ucds:item:";
const ITEM_DEF_PREFIX = "ucds:itemdef:";
const ITEM_DEF_HASH_LENGTH = 14;

const IGNORED_DYNAMIC_PROPERTIES = new Set([
  "cell_data",
  "ucds_cell_id",
]);

const HIDDEN_LORE_MARKERS = [
  "ucds_key:",
  "Count:",
];

function getItemDefKey(defId) {
  return `${ITEM_DEF_PREFIX}${defId}`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortObject(value[key]);
  }
  return sorted;
}

function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

function hashString(value) {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;

  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const high = (h2 >>> 0).toString(36).padStart(7, "0");
  const low = (h1 >>> 0).toString(36).padStart(7, "0");
  return `${high}${low}`.slice(0, ITEM_DEF_HASH_LENGTH);
}

function readItemDefinition(defId) {
  const raw = world.getDynamicProperty(getItemDefKey(defId));
  if (typeof raw !== "string") return undefined;

  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : undefined;
  } catch {
    return undefined;
  }
}

function writeItemDefinition(defId, canonicalJson) {
  world.setDynamicProperty(getItemDefKey(defId), canonicalJson);
}

function stripFormatting(text = "") {
  return String(text).replace(/\u00A7./g, "");
}

function stripStorageLore(lore = []) {
  return lore.filter((line) => {
    const plain = stripFormatting(line);
    return !HIDDEN_LORE_MARKERS.some((marker) => plain.includes(marker));
  });
}

function getDynamicProperties(item) {
  const ids = item.getDynamicPropertyIds?.() ?? [];
  if (ids.length === 0) return undefined;

  const dynProps = {};
  for (const id of [...ids].sort()) {
    if (IGNORED_DYNAMIC_PROPERTIES.has(id)) continue;
    const value = item.getDynamicProperty(id);
    if (value !== undefined) dynProps[id] = value;
  }

  return Object.keys(dynProps).length > 0 ? dynProps : undefined;
}

function getCanonicalItemData(item) {
  if (!item) return undefined;

  const data = { typeId: item.typeId };

  if (item.nameTag) data.nameTag = item.nameTag;

  const lore = stripStorageLore(item.getLore?.() ?? []);
  if (lore.length > 0) data.lore = lore;

  const durability = item.getComponent("durability");
  if (durability && durability.damage > 0) data.damage = durability.damage;

  const enchantable = item.getComponent("enchantable");
  if (enchantable) {
    const enchants = enchantable.getEnchantments()
      .map((entry) => ({ type: entry.type.id, level: entry.level }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.level - b.level);
    if (enchants.length > 0) data.enchants = enchants;
  }

  const canPlaceOn = item.getCanPlaceOn?.() ?? [];
  if (canPlaceOn.length > 0) data.canPlaceOn = [...canPlaceOn].sort();

  const canDestroy = item.getCanDestroy?.() ?? [];
  if (canDestroy.length > 0) data.canDestroy = [...canDestroy].sort();

  const dynProps = getDynamicProperties(item);
  if (dynProps) data.dynProps = dynProps;

  return data;
}

function hasExtraData(data) {
  return !!data && Object.keys(data).some((key) => key !== "typeId");
}

function getOrCreateItemDefinitionKey(data) {
  const canonicalJson = stableStringify(data);
  const baseId = hashString(canonicalJson);

  for (let suffix = 0; suffix < 1000; suffix++) {
    const defId = suffix === 0 ? baseId : `${baseId}_${suffix}`;
    const key = getItemDefKey(defId);
    const existing = world.getDynamicProperty(key);

    if (existing === canonicalJson) return `${ITEM_KEY_PREFIX}${defId}`;
    if (typeof existing !== "string") {
      writeItemDefinition(defId, canonicalJson);
      return `${ITEM_KEY_PREFIX}${defId}`;
    }
  }

  throw new Error("Unable to allocate Digital Storage item definition.");
}

function createItemFromData(data, amount) {
  let item;
  try {
    item = new ItemStack(data?.typeId, Math.max(1, Math.floor(Number(amount) || 1)));
  } catch {
    return new ItemStack("minecraft:dirt", Math.max(1, Math.floor(Number(amount) || 1)));
  }

  if (data.nameTag) item.nameTag = data.nameTag;
  if (Array.isArray(data.lore) && data.lore.length > 0) item.setLore(data.lore);

  if (data.damage) {
    const durability = item.getComponent("durability");
    if (durability) durability.damage = data.damage;
  }

  if (Array.isArray(data.enchants)) {
    const enchantable = item.getComponent("enchantable");
    if (enchantable) {
      for (const enchantment of data.enchants) {
        try {
          enchantable.addEnchantment({
            type: EnchantmentTypes.get(enchantment.type),
            level: enchantment.level,
          });
        } catch {}
      }
    }
  }

  if (Array.isArray(data.canPlaceOn)) item.setCanPlaceOn(data.canPlaceOn);
  if (Array.isArray(data.canDestroy)) item.setCanDestroy(data.canDestroy);

  if (data.dynProps && typeof data.dynProps === "object") {
    for (const id of Object.keys(data.dynProps)) {
      try {
        item.setDynamicProperty(id, data.dynProps[id]);
      } catch {}
    }
  }

  return item;
}

/**
 * Converts an ItemStack into a stable storage key.
 *
 * The key includes important item identity data: name tag, cleaned lore,
 * durability damage, enchantments, dynamic properties, canPlaceOn and
 * canDestroy. Digital Storage internal metadata is stripped before hashing.
 *
 * @param {import("@minecraft/server").ItemStack} item Item to identify.
 * @returns {string} Type id for simple items, or `ucds:item:<id>` for special items.
 */
export function getItemKey(item) {
  const data = getCanonicalItemData(item);
  if (!data) return "";
  if (!hasExtraData(data)) return data.typeId;
  return getOrCreateItemDefinitionKey(data);
}

/**
 * Recreates an ItemStack from a stable storage key.
 *
 * @param {string} itemKey Stable item key.
 * @param {number} amount Stack amount to create.
 * @returns {import("@minecraft/server").ItemStack} Recreated item stack.
 */
export function createItemFromKey(itemKey, amount) {
  const key = String(itemKey ?? "");
  if (key.startsWith(ITEM_KEY_PREFIX)) {
    const defId = key.slice(ITEM_KEY_PREFIX.length);
    const definition = readItemDefinition(defId);
    if (definition) return createItemFromData(definition, amount);
    return new ItemStack("minecraft:dirt", Math.max(1, Math.floor(Number(amount) || 1)));
  }

  return createItemFromData({ typeId: key }, amount);
}

/**
 * Reads the persisted item definition for a key.
 *
 * Simple type-id keys return `{ typeId }`.
 *
 * @param {string} itemKey Stable item key.
 * @returns {object | undefined} Canonical item definition.
 */
export function getItemDefinition(itemKey) {
  const key = String(itemKey ?? "");
  if (!key.startsWith(ITEM_KEY_PREFIX)) return { typeId: key };
  return readItemDefinition(key.slice(ITEM_KEY_PREFIX.length));
}
