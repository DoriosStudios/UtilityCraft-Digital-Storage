import { system, world } from "@minecraft/server";
import {
  flushAllNetworks,
  loadAllNetworksJob,
} from "./network_runtime.js";
import "./network_debug.js";
import "./network_topology.js";
import "./machines/storage_cell_drive.js";
import "./machines/storage_center.js";
import "./machines/storage_terminal.js";

/**
 * Storage V2 lifecycle bootstrap.
 *
 * World load builds runtime caches from persisted network/cell records. Shutdown
 * flushes dirty runtime networks back into dynamic properties. Terminal/UI code
 * should not do its own bootstrap work; it should consume `network_runtime.js`.
 */

world.afterEvents.worldLoad.subscribe(() => {
  console.warn("[DSv2] queued incremental storage network load.");
  system.runJob(loadAllNetworksJob({
    recordsPerTick: 8,
    onComplete: ({ loaded, total, cells }) => {
      console.warn(`[DSv2] loaded ${loaded}/${total} storage network runtime(s), ${cells} cell record(s).`);
    },
  }));
});

system.beforeEvents.shutdown.subscribe(() => {
  const flushed = flushAllNetworks({ onlyDirty: true });
  console.warn(`[DSv2] flushed ${flushed} dirty storage network runtime(s).`);
});
