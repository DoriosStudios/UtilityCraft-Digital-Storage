export const RANGE_UPGRADE_ID = "utilitycraft:range_upgrade";
export const DIMENSIONAL_RANGE_UPGRADE_ID = "utilitycraft:dimensional_range_upgrade";
export const BASE_WIRELESS_RANGE = 64;
export const RANGE_PER_UPGRADE = 128;
export const MAX_RANGE_UPGRADES = 8;

export function normalizeWirelessRange(value) {
  const range = Math.floor(Number(value));
  return Number.isFinite(range) && range > 0 ? range : BASE_WIRELESS_RANGE;
}

/**
 * Resolves the wireless access granted by the Storage Center upgrade slot.
 * Normal Range Upgrades add another base range per installed level. The
 * Dimensional Range Upgrade bypasses both distance and dimension checks.
 *
 * @param {{typeId?: string, amount?: number} | undefined} item
 * @returns {{range:number, dimensional:boolean, level:number}}
 */
export function getWirelessAccessFromUpgrade(item) {
  if (item?.typeId === DIMENSIONAL_RANGE_UPGRADE_ID) {
    return { range: BASE_WIRELESS_RANGE, dimensional: true, level: MAX_RANGE_UPGRADES };
  }

  const level = item?.typeId === RANGE_UPGRADE_ID
    ? Math.min(MAX_RANGE_UPGRADES, Math.max(0, Math.floor(Number(item.amount) || 0)))
    : 0;
  return {
    range: BASE_WIRELESS_RANGE + RANGE_PER_UPGRADE * level,
    dimensional: false,
    level,
  };
}

/**
 * Parses a center key formatted as `<dimension id>:<x>,<y>,<z>`.
 * `lastIndexOf` preserves namespaced and custom dimension identifiers.
 *
 * @param {string} centerKey
 * @returns {{dimensionId:string, location:{x:number,y:number,z:number}} | undefined}
 */
export function parseWirelessCenterKey(centerKey) {
  const key = String(centerKey ?? "");
  const splitIndex = key.lastIndexOf(":");
  if (splitIndex <= 0 || splitIndex >= key.length - 1) return undefined;

  const dimensionId = key.slice(0, splitIndex);
  const coordinates = key.slice(splitIndex + 1).split(",").map(Number);
  if (coordinates.length !== 3 || coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    return undefined;
  }

  return {
    dimensionId,
    location: {
      x: coordinates[0] + 0.5,
      y: coordinates[1] + 0.5,
      z: coordinates[2] + 0.5,
    },
  };
}

/**
 * Checks one player position against the wireless settings cached by a network.
 *
 * @param {{online?:boolean,center?:string,wirelessRange?:number,wirelessDimensional?:boolean} | undefined} network
 * @param {string} dimensionId
 * @param {{x:number,y:number,z:number} | undefined} location
 * @returns {{allowed:boolean, reason?:"offline"|"dimension"|"range"}}
 */
export function checkWirelessAccess(network, dimensionId, location) {
  if (!network?.online) return { allowed: false, reason: "offline" };
  if (network.wirelessDimensional === true) return { allowed: true };

  const center = parseWirelessCenterKey(network.center ?? "");
  if (!center || !location) return { allowed: false, reason: "offline" };
  if (center.dimensionId !== dimensionId) return { allowed: false, reason: "dimension" };

  const range = normalizeWirelessRange(network.wirelessRange);
  const dx = location.x - center.location.x;
  const dy = location.y - center.location.y;
  const dz = location.z - center.location.z;
  return dx * dx + dy * dy + dz * dz <= range * range
    ? { allowed: true }
    : { allowed: false, reason: "range" };
}
