# UtilityCraft: Digital Storage

Digital item-network addon for UtilityCraft 3.5.0 or newer. The runtime uses
DoriosCore's public machinery API and DoriosLib 2.0 for dependency discovery,
component registration, container routing, and shared link-node services.

Item automation uses face-independent Dorios container `simple` policies:
terminals import through slots 0-3, the import buffer through 0-17, and the
export buffer exposes slots 9-35 only as outputs. Filter, upgrade, and UI slots
are never available to automation; the storage center and cell drive expose no
item slots.

## Development

```powershell
npm install
npm run check
npm run verify:imports
npm run bundle
```

The production Regolith profiles bundle `BP/scripts/main.js`. Code owned by
Digital Storage lives outside `BP/scripts/DoriosCore` and
`BP/scripts/DoriosLib`; those directories are read-only UtilityCraft snapshots.
