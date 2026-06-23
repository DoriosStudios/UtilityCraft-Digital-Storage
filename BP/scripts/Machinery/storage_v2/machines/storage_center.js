import { system } from "@minecraft/server";
import { spawnEntity } from "DoriosCore/utils/entity.js";

export const STORAGE_CENTER_ENTITY_TYPE = "utilitycraft:storage_center";

function getStorageCenterEntity(block) {
  return block?.dimension
    ?.getEntitiesAtBlockLocation(block.location)
    ?.find((entity) => entity.typeId === STORAGE_CENTER_ENTITY_TYPE);
}

DoriosAPI.register.blockComponent("storage_center", {
  onPlace({ block }) {
    system.run(() => {
      spawnEntity(block, {
        entity: {
          identifier: STORAGE_CENTER_ENTITY_TYPE,
          inventory_size: 2,
          name: "storage_center",
        },
      });
    });
  },

  onTick() {
    // Network center logic will be added after topology scanning is stable.
  },

  onPlayerBreak({ block }) {
    const entity = getStorageCenterEntity(block);
    if (!entity?.isValid) return;
    entity.triggerEvent("despawn");
  },
});
