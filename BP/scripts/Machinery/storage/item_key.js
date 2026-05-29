import { EnchantmentTypes, ItemStack } from "@minecraft/server";
import { stripHiddenLore } from "./virtual_item_codec.js";

export function getItemKey(item) {
  if (!item) return "";

  let key = item.typeId;
  const extras = {};

  if (item.nameTag) extras.nameTag = item.nameTag;

  const lore = stripHiddenLore(item.getLore?.() ?? []);
  const cleanLore = lore.filter((line) => !line.includes("- Count:"));
  if (cleanLore.length > 0) extras.lore = cleanLore;

  const durability = item.getComponent("durability");
  if (durability && durability.damage > 0) extras.damage = durability.damage;

  const enchantable = item.getComponent("enchantable");
  if (enchantable) {
    const enchantments = enchantable.getEnchantments();
    if (enchantments.length > 0) {
      extras.enchants = enchantments.map((entry) => ({
        type: entry.type.id,
        level: entry.level,
      }));
    }
  }

  const dynamicPropertyIds = item.getDynamicPropertyIds?.() ?? [];
  if (dynamicPropertyIds.length > 0) {
    extras.dynProps = {};
    for (const id of dynamicPropertyIds) {
      if (id === "cell_data") continue;
      extras.dynProps[id] = item.getDynamicProperty(id);
    }
  }

  if (Object.keys(extras).length > 0) {
    key += `||${JSON.stringify(extras)}`;
  }

  return key;
}

export function createItemFromKey(key, amount) {
  const parts = String(key).split("||");
  const typeId = parts[0];
  let item;

  try {
    item = new ItemStack(typeId, amount);
  } catch {
    return new ItemStack("minecraft:dirt", amount);
  }

  if (parts.length <= 1) return item;

  try {
    const extras = JSON.parse(parts[1]);
    if (extras.nameTag) item.nameTag = extras.nameTag;
    if (extras.lore) item.setLore(extras.lore);

    if (extras.damage) {
      const durability = item.getComponent("durability");
      if (durability) durability.damage = extras.damage;
    }

    if (extras.enchants) {
      const enchantable = item.getComponent("enchantable");
      if (enchantable) {
        for (const data of extras.enchants) {
          try {
            enchantable.addEnchantment({
              type: EnchantmentTypes.get(data.type),
              level: data.level,
            });
          } catch {}
        }
      }
    }

    if (extras.dynProps) {
      for (const id in extras.dynProps) {
        try {
          item.setDynamicProperty(id, extras.dynProps[id]);
        } catch {}
      }
    }
  } catch {}

  return item;
}
