import { system, world } from "@minecraft/server";
import {
  flushAllNetworks,
  loadAllNetworksJob,
  markStorageRuntimeFailure,
  startNetworkAutoFlush,
} from "./network_runtime.js";
import { initializeOpaqueVaults } from "./opaque_vault.js";
import { recoverCellTransactionsJob } from "./persistence/cell_transactions.js";
import "./upgrade_register.js";
import "./network_debug.js";
import "./network_topology.js";
import "./machines/export_buffer.js";
import "./machines/import_buffer.js";
import "./machines/crafting_terminal.js";
import "./machines/storage_cell_drive.js";
import "./machines/storage_transfer_station.js";
import "./machines/storage_center.js";
import "./machines/storage_terminal.js";
import "./machines/wireless_panel.js";

/**
 * Digital Storage lifecycle bootstrap.
 *
 * World load builds runtime caches from persisted network/cell records. Shutdown
 * flushes dirty runtime networks back into dynamic properties. Terminal/UI code
 * should not do its own bootstrap work; it should consume `network_runtime.js`.
 */

world.afterEvents.worldLoad.subscribe(() => {
  // console.warn("[DigitalStorage] queued incremental storage network load.");
  initializeOpaqueVaults();
  startNetworkAutoFlush();
  system.runJob(initializeStorageRuntimeJob());
});

function* initializeStorageRuntimeJob() {
  try {
    yield* recoverCellTransactionsJob();
    yield* loadAllNetworksJob({
      recordsPerTick: 8,
      onComplete: ({ loaded, total, cells }) => {
        // console.warn(`[DigitalStorage] loaded ${loaded}/${total} storage network runtime(s), ${cells} cell record(s).`);
      },
    });
  } catch (error) {
    markStorageRuntimeFailure(error);
    console.error(`[DigitalStorage] Storage startup is locked after a recovery failure: ${error?.stack ?? error}`);
  }
}

system.beforeEvents.shutdown.subscribe(() => {
  const flushed = flushAllNetworks({ onlyDirty: true, syncDriveItems: false });
  // console.warn(`[DigitalStorage] flushed ${flushed} dirty storage network runtime(s).`);
});
