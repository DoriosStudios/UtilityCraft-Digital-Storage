// @ts-check

import { Machine } from "DoriosCore/index.js";
import * as DoriosLib from "DoriosLib/index.js";

/**
 * @typedef {object} StorageMachineOptions
 * @property {number[]} [inputSlots]
 * @property {number[]} [outputSlots]
 */

/**
 * Uses DoriosCore's public placement lifecycle while adapting Digital
 * Storage's dedicated entity types. The entity `type` event is disabled
 * because these entities declare their final component layout directly.
 *
 * @param {import("@minecraft/server").BlockComponentPlayerPlaceBeforeEvent} event
 * @param {unknown} settings
 * @param {StorageMachineOptions} options
 * @param {(entity: import("@minecraft/server").Entity) => void} [callback]
 */
export function spawnStorageMachine(event, settings, options, callback) {
  if (!event.player) return;
  if (!settings || typeof settings !== "object" || !("entity" in settings) || !("machine" in settings)) {
    throw new TypeError("Digital Storage machine settings are missing entity or machine configuration");
  }

  const placement = /** @type {import("DoriosCore/index.js").PlacementEventLike} */ (event);
  const config = /** @type {import("DoriosCore/index.js").MachineSettings} */ (settings);
  Machine.spawnEntity(placement, config, (entity) => {
    if (DoriosLib.container.isCompatible(entity)) {
      configureFixedItemSlots(entity, options.inputSlots ?? [], options.outputSlots ?? []);
    }
    callback?.(entity);
  });
}

/**
 * Publishes one face-independent Dorios container policy. These machines have
 * no configurable IO, so every connection uses the same explicit slot lists.
 *
 * @param {import("@minecraft/server").Entity} entity
 * @param {number[]} inputSlots
 * @param {number[]} outputSlots
 */
export function configureFixedItemSlots(entity, inputSlots, outputSlots) {
  DoriosLib.container.setConfig(entity, {
    version: 1,
    type: "simple",
    inputConfig: normalizeSlots(inputSlots),
    outputConfig: normalizeSlots(outputSlots),
  });
}

/** @param {number[]} slots */
function normalizeSlots(slots) {
  return [...new Set(slots.filter((slot) => Number.isInteger(slot) && slot >= 0))];
}
