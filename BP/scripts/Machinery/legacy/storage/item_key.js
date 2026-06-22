import { EnchantmentTypes, ItemStack, world } from "@minecraft/server";
import { stripHiddenLore } from "./virtual_item_codec.js";

const ITEM_KEY_PREFIX = "ucds:item:";
const ITEM_DEF_PREFIX = "ucds:itemdef:";
const ITEM_DEF_HASH_LENGTH = 14;
const IGNORED_DYNAMIC_PROPERTIES = new Set([
  "cell_data",
]);

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

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

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

function getDynamicProperties(item) {
  const dynamicPropertyIds = item.getDynamicPropertyIds?.() ?? [];
  if (dynamicPropertyIds.length === 0) return undefined;

  const dynProps = {};
  for (const id of [...dynamicPropertyIds].sort()) {
    if (IGNORED_DYNAMIC_PROPERTIES.has(id)) continue;
    dynProps[id] = item.getDynamicProperty(id);
  }

  return Object.keys(dynProps).length > 0 ? dynProps : undefined;
}

function getCanonicalItemData(item) {
  if (!item) return undefined;

  const data = {
    typeId: item.typeId,
  };

  if (item.nameTag) data.nameTag = item.nameTag;

  const lore = stripHiddenLore(item.getLore?.() ?? []);
  const cleanLore = lore.filter((line) => !line.includes("- Count:"));
  if (cleanLore.length > 0) data.lore = cleanLore;

  const durability = item.getComponent("durability");
  if (durability && durability.damage > 0) data.damage = durability.damage;

  const enchantable = item.getComponent("enchantable");
  if (enchantable) {
    const enchantments = enchantable.getEnchantments()
      .map((entry) => ({
        type: entry.type.id,
        level: entry.level,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.level - b.level);
    if (enchantments.length > 0) data.enchants = enchantments;
  }

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
    const existing = world.getDynamicProperty(getItemDefKey(defId));

    if (existing === canonicalJson) return `${ITEM_KEY_PREFIX}${defId}`;
    if (typeof existing !== "string") {
      writeItemDefinition(defId, canonicalJson);
      return `${ITEM_KEY_PREFIX}${defId}`;
    }
  }

  throw new Error("Unable to allocate a unique Digital Storage item definition.");
}

function createItemFromData(data, amount) {
  let item;

  try {
    item = new ItemStack(data?.typeId, amount);
  } catch {
    return new ItemStack("minecraft:dirt", amount);
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

  if (data.dynProps && typeof data.dynProps === "object") {
    for (const id of Object.keys(data.dynProps)) {
      try {
        item.setDynamicProperty(id, data.dynProps[id]);
      } catch {}
    }
  }

  return item;
}

function getDataFromLegacyKey(key) {
  const parts = String(key).split("||");
  const typeId = parts[0];
  if (parts.length <= 1) return { typeId };

  try {
    const extras = JSON.parse(parts.slice(1).join("||"));
    return { typeId, ...extras };
  } catch {
    return undefined;
  }
}

export function getItemKey(item) {
  const data = getCanonicalItemData(item);
  if (!data) return "";
  if (!hasExtraData(data)) return data.typeId;
  return getOrCreateItemDefinitionKey(data);
}

export function normalizeItemKey(key) {
  const itemKey = String(key ?? "");
  if (!itemKey || itemKey.startsWith(ITEM_KEY_PREFIX) || !itemKey.includes("||")) {
    return itemKey;
  }

  const data = getDataFromLegacyKey(itemKey);
  if (!data) return itemKey;
  if (!hasExtraData(data)) return data.typeId;
  return getOrCreateItemDefinitionKey(data);
}

export function createItemFromKey(key, amount) {
  const itemKey = String(key ?? "");
  if (itemKey.startsWith(ITEM_KEY_PREFIX)) {
    const defId = itemKey.slice(ITEM_KEY_PREFIX.length);
    const definition = readItemDefinition(defId);
    if (definition) return createItemFromData(definition, amount);
    return new ItemStack("minecraft:dirt", amount);
  }

  const data = getDataFromLegacyKey(itemKey);
  if (data) return createItemFromData(data, amount);

  try {
    return new ItemStack(itemKey, amount);
  } catch {
    return new ItemStack("minecraft:dirt", amount);
  }
}
