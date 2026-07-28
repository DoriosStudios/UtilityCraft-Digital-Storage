import { StorageTerminalInterface } from "../../interface/terminal.js";
import * as DoriosLib from "DoriosLib/index.js";

StorageTerminalInterface.registerButtons();
StorageTerminalInterface.registerScriptEvents();

DoriosLib.registry.blockComponent("utilitycraft:storage_terminal", {
  beforeOnPlayerPlace(event, { params: settings }) {
    StorageTerminalInterface.place(event, settings);
  },

  onTick({ block }) {
    const terminal = new StorageTerminalInterface(block);
    terminal.tick();
  },

  onPlayerBreak({ block }) {
    StorageTerminalInterface.destroyBlock(block);
  },
});
