const SECTION = "\u00A7";
const LEGACY_NETWORK_PREFIX = `${SECTION}0${SECTION}1${SECTION}2${SECTION}3`;
const LEGACY_ITEM_KEY_PREFIX = `${SECTION}0ucds_key:`;
const METADATA_PREFIX = `${SECTION}n${SECTION}e${SECTION}k${SECTION}r`;

function encodeDecimal(value) {
  return String(Math.max(0, Math.floor(Number(value) || 0)))
    .split("")
    .map((digit) => `${SECTION}${digit}`)
    .join("");
}

function decodeDecimal(value) {
  const digits = [];
  for (let i = 0; i < value.length - 1; i++) {
    if (value[i] === SECTION && /[0-9]/.test(value[i + 1])) {
      digits.push(value[i + 1]);
      i++;
    }
  }
  if (digits.length === 0) return undefined;
  const parsed = Number.parseInt(digits.join(""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function encodeNetworkLore(networkId) {
  return `${LEGACY_NETWORK_PREFIX}${encodeDecimal(networkId)}`;
}

export function encodeItemKeyLore(itemKey) {
  return `${LEGACY_ITEM_KEY_PREFIX}${encodeURIComponent(itemKey)}`;
}

export function isHiddenLoreLine(line) {
  return typeof line === "string" && (
    line.startsWith(LEGACY_NETWORK_PREFIX) ||
    line.startsWith(LEGACY_ITEM_KEY_PREFIX) ||
    line.startsWith(METADATA_PREFIX)
  );
}

export function stripHiddenLore(lore = []) {
  const cleanLore = [];
  for (const line of lore) {
    if (isHiddenLoreLine(line)) continue;
    const metadataIndex = typeof line === "string" ? line.indexOf(METADATA_PREFIX) : -1;
    cleanLore.push(metadataIndex >= 0 ? line.slice(0, metadataIndex) : line);
  }
  return cleanLore;
}

function encodeMetadata(networkId, itemKey) {
  const payload = encodeURIComponent(JSON.stringify({
    n: Math.max(0, Math.floor(Number(networkId) || 0)),
    k: itemKey,
  }));
  let encoded = "";
  for (const char of payload) {
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    encoded += `${SECTION}${hex[0]}${SECTION}${hex[1]}`;
  }
  return `${METADATA_PREFIX}${encoded}`;
}

function decodeMetadata(line) {
  const metadataIndex = typeof line === "string" ? line.indexOf(METADATA_PREFIX) : -1;
  if (metadataIndex < 0) return undefined;

  const encoded = line.slice(metadataIndex + METADATA_PREFIX.length);
  let hex = "";
  for (let i = 0; i < encoded.length - 1; i++) {
    if (encoded[i] === SECTION && /[0-9a-f]/i.test(encoded[i + 1])) {
      hex += encoded[i + 1];
      i++;
    }
  }

  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;

  let payload = "";
  for (let i = 0; i < hex.length; i += 2) {
    payload += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }

  try {
    const data = JSON.parse(decodeURIComponent(payload));
    if (!Number.isInteger(data.n) || !data.k) return undefined;
    return { networkId: data.n, itemKey: data.k };
  } catch {
    return undefined;
  }
}

export function applyVirtualLore(item, visibleLore, networkId, itemKey) {
  const lore = stripHiddenLore(visibleLore);
  const metadata = encodeMetadata(networkId, itemKey);
  if (lore.length === 0) lore.push(metadata);
  else lore[lore.length - 1] = `${lore[lore.length - 1]}${metadata}`;
  item.setLore(lore);
  return item;
}

export function needsVirtualLoreRewrite(item) {
  const lore = item?.getLore?.() ?? [];
  return (
    lore.some((line) =>
      line.startsWith(LEGACY_NETWORK_PREFIX) ||
      line.startsWith(LEGACY_ITEM_KEY_PREFIX)
    ) ||
    !lore.some((line) => typeof line === "string" && line.includes(METADATA_PREFIX))
  );
}

export function readVirtualItemData(item) {
  const lore = item?.getLore?.() ?? [];
  let networkId;
  let itemKey;

  for (const line of lore) {
    const metadata = decodeMetadata(line);
    if (metadata) return metadata;

    if (line.startsWith(LEGACY_NETWORK_PREFIX)) {
      networkId = decodeDecimal(line.slice(LEGACY_NETWORK_PREFIX.length));
      continue;
    }

    if (line.startsWith(LEGACY_ITEM_KEY_PREFIX)) {
      try {
        itemKey = decodeURIComponent(line.slice(LEGACY_ITEM_KEY_PREFIX.length));
      } catch {
        itemKey = undefined;
      }
    }
  }

  if (!Number.isInteger(networkId) || !itemKey) return undefined;
  return { networkId, itemKey };
}
