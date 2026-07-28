import { CraftingTerminalInterface } from "../../interface/crafting_terminal.js";
import * as DoriosLib from "DoriosLib/index.js";

CraftingTerminalInterface.registerButtons();

DoriosLib.registry.blockComponent("utilitycraft:crafting_terminal", {
  beforeOnPlayerPlace(event, { params: settings }) {
    CraftingTerminalInterface.place(event, settings);
  },

  onTick({ block }) {
    const terminal = new CraftingTerminalInterface(block);
    terminal.tick();
  },

  onPlayerBreak({ block }) {
    CraftingTerminalInterface.destroyBlock(block);
  },
});
