import * as DoriosLib from "DoriosLib/index.js";
import { DIMENSIONAL_RANGE_UPGRADE_ID, MAX_RANGE_UPGRADES } from "./wireless_access.js";

DoriosLib.registry.registerMachineUpgrade({
  [DIMENSIONAL_RANGE_UPGRADE_ID]: {
    type: "range",
    value: MAX_RANGE_UPGRADES,
    levels: {
      [MAX_RANGE_UPGRADES]: { range: MAX_RANGE_UPGRADES, dimensional_range: 1 },
    },
  },
});
