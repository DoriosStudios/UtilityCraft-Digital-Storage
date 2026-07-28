// @ts-check

// Canonical UtilityCraft dependencies. Addon code imports DoriosCore only
// through its public root and uses DoriosLib for shared services.
import "DoriosCore/index.js";
import * as DoriosLib from "DoriosLib/index.js";

import "./Config/index.js";
import "./Machinery/index.js";

// Install registrations only after every Digital Storage module has loaded.
DoriosLib.registry.install();
DoriosLib.container.initialize();
DoriosLib.linkNode.initializeLinkNodeIO();
