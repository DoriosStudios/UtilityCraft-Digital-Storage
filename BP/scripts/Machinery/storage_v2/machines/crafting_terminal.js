import { CraftingTerminalInterface } from "../../interface/crafting_terminal.js";

CraftingTerminalInterface.registerButtons();

DoriosAPI.register.blockComponent("crafting_terminal", {
  onPlace({ block }) {
    CraftingTerminalInterface.place(block);
  },

  onTick({ block }) {
    const terminal = new CraftingTerminalInterface(block);
    terminal.tick();
  },

  onPlayerBreak({ block }) {
    CraftingTerminalInterface.destroyBlock(block);
  },
});
