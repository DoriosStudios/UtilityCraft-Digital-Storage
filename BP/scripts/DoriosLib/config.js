// @ts-check

/**
 * Metadata announced by this DoriosLib installation to other addons in the
 * world through `dorios:dependency_checker`.
 *
 * Add dependency requirements to `dependencies` when UtilityCraft starts
 * depending on another Dorios addon.
 *
 * @type {import("./dependencies/index.js").AddonMetadata}
 */
export const ADDON_METADATA = {
  name: "UtilityCraft: Digital Storage",
  author: "Dorios Studios",
  identifier: "uc_digital_storage",
  version: "1.0.0.07",
  dependencies: {
    utilitycraft: {
      name: "UtilityCraft",
      version: "3.5.1",
      warning: "Digital Storage requires UtilityCraft 3.5.1 or newer.",
    },
  },
};

/** @type {import("./dependencies/index.js").InitializeOptions} */
export const DEPENDENCY_OPTIONS = {
  validationDelayTicks: 300,
  announceSuccess: true,
};
