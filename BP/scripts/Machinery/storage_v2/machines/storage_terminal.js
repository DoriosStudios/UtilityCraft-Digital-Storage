import { StorageTerminalInterface } from "../../interface/terminal.js";

StorageTerminalInterface.registerButtons();
StorageTerminalInterface.registerScriptEvents();

DoriosAPI.register.blockComponent("storage_terminal", {
  onPlace({ block }) {
    StorageTerminalInterface.place(block);
  },

  onTick({ block }) {
    const terminal = new StorageTerminalInterface(block);
    terminal.tick();
  },

  onPlayerBreak({ block }) {
    StorageTerminalInterface.destroyBlock(block);
  },
});
