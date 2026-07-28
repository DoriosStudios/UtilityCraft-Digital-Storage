// @ts-check

import { Machine, registerIOInterface } from "DoriosCore/index.js";
import * as DoriosLib from "DoriosLib/index.js";

const CONTAINER_FACES = ["up", "down", "north", "south", "east", "west"];

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
    configureFixedItemSlots(entity, options.inputSlots ?? [], options.outputSlots ?? []);
    callback?.(entity);
  });
}

/**
 * Registers one immutable slot policy with DoriosCore. No interface buttons
 * are declared, so players cannot cycle or reassign individual faces.
 *
 * @param {string} blockTypeId
 * @param {number[]} [inputSlots]
 * @param {number[]} [outputSlots]
 */
export function registerFixedItemIO(blockTypeId, inputSlots = [], outputSlots = []) {
  const inputs = normalizeSlots(inputSlots);
  const outputs = normalizeSlots(outputSlots);
  const modes = [{ id: "disabled" }];

  if (inputs.length > 0 || outputs.length > 0) {
    modes.push({ id: "fixed", inputSlots: inputs, outputSlots: outputs });
  }

  return registerIOInterface(blockTypeId, {
    items: {
      anyInputSlots: inputs,
      anyOutputSlots: outputs,
      modes,
    },
  });
}

/**
 * Publishes the registered non-dynamic slot policy. Every face receives the
 * same explicit lists, so automation can only access the intended slots while
 * DoriosCore can validate the document without replacing it on machine ticks.
 *
 * @param {import("@minecraft/server").Entity} entity
 * @param {number[]} inputSlots
 * @param {number[]} outputSlots
 */
export function configureFixedItemSlots(entity, inputSlots, outputSlots) {
  const inputs = normalizeSlots(inputSlots);
  const outputs = normalizeSlots(outputSlots);
  const inputConfig = createFaceConfig(inputs);
  const outputConfig = createFaceConfig(outputs);

  DoriosLib.container.setConfig(entity, {
    version: 1,
    type: "complex",
    anyInputSlots: inputs,
    anyOutputSlots: outputs,
    inputConfig,
    outputConfig,
  });
}

/** @param {number[]} slots */
function createFaceConfig(slots) {
  if (slots.length === 0) return {};
  return Object.fromEntries(CONTAINER_FACES.map((face) => [face, [...slots]]));
}

/** @param {number[]} slots */
function normalizeSlots(slots) {
  return [...new Set(slots.filter((slot) => Number.isInteger(slot) && slot >= 0))];
}
