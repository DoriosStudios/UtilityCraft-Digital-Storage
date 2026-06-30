const SECTION = "\u00A7";
const LEGACY_NETWORK_PREFIX = `${SECTION}0${SECTION}1${SECTION}2${SECTION}3`;
const LEGACY_ITEM_KEY_PREFIX = `${SECTION}0ucds_key:`;
const METADATA_PREFIX = `${SECTION}n${SECTION}e${SECTION}k${SECTION}r`;
const RENDER_METADATA_PREFIX = `${SECTION}r${SECTION}e${SECTION}n${SECTION}d`;

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
    line.startsWith(METADATA_PREFIX) ||
    line.startsWith(RENDER_METADATA_PREFIX)
  );
}

export function stripHiddenLore(lore = []) {
  const cleanLore = [];
  for (const line of lore) {
    if (isHiddenLoreLine(line)) continue;
    if (typeof line !== "string") {
      cleanLore.push(line);
      continue;
    }

    const hiddenIndexes = [
      line.indexOf(METADATA_PREFIX),
      line.indexOf(RENDER_METADATA_PREFIX),
    ].filter((index) => index >= 0);
    const firstHiddenIndex = hiddenIndexes.length > 0 ? Math.min(...hiddenIndexes) : -1;
    cleanLore.push(firstHiddenIndex >= 0 ? line.slice(0, firstHiddenIndex) : line);
  }
  return cleanLore;
}

function encodeHiddenPayload(prefix, data) {
  const payload = encodeURIComponent(JSON.stringify(data));
  let encoded = "";
  for (const char of payload) {
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    encoded += `${SECTION}${hex[0]}${SECTION}${hex[1]}`;
  }
  return `${prefix}${encoded}`;
}

function encodeMetadata(networkId, itemKey) {
  return encodeHiddenPayload(METADATA_PREFIX, {
    n: Math.max(0, Math.floor(Number(networkId) || 0)),
    k: itemKey,
  });
}

function encodeRenderMetadata({ networkId, itemKey, entityId, slot } = {}) {
  if (typeof entityId !== "string" || entityId.length === 0) return undefined;
  const slotIndex = Math.floor(Number(slot));
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return undefined;

  return encodeHiddenPayload(RENDER_METADATA_PREFIX, {
    n: Math.max(0, Math.floor(Number(networkId) || 0)),
    k: itemKey,
    e: entityId,
    s: slotIndex,
  });
}

function decodeHiddenPayload(line, prefix) {
  const metadataIndex = typeof line === "string" ? line.indexOf(prefix) : -1;
  if (metadataIndex < 0) return undefined;

  const encoded = line.slice(metadataIndex + prefix.length);
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
    return JSON.parse(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
}

function decodeMetadata(line) {
  const data = decodeHiddenPayload(line, METADATA_PREFIX);
  if (!data || !Number.isInteger(data.n) || !data.k) return undefined;
  return { networkId: data.n, itemKey: data.k };
}

function decodeRenderMetadata(line) {
  const data = decodeHiddenPayload(line, RENDER_METADATA_PREFIX);
  if (!data || !Number.isInteger(data.n) || !data.k) return undefined;
  if (typeof data.e !== "string" || !Number.isInteger(data.s)) return undefined;
  return {
    networkId: data.n,
    itemKey: data.k,
    entityId: data.e,
    slot: data.s,
  };
}

export function applyVirtualLore(item, visibleLore, networkId, itemKey, renderContext) {
  const lore = stripHiddenLore(visibleLore);
  const metadata = encodeMetadata(networkId, itemKey);
  const renderMetadata = encodeRenderMetadata({
    networkId,
    itemKey,
    entityId: renderContext?.entityId,
    slot: renderContext?.slot,
  });
  if (lore.length === 0) lore.push(metadata);
  else lore[lore.length - 1] = `${lore[lore.length - 1]}${metadata}`;
  if (renderMetadata) lore.push(renderMetadata);
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
    !lore.some((line) => typeof line === "string" && line.includes(METADATA_PREFIX)) ||
    !lore.some((line) => typeof line === "string" && line.includes(RENDER_METADATA_PREFIX))
  );
}

export function readVirtualItemData(item) {
  const lore = item?.getLore?.() ?? [];
  let networkId;
  let itemKey;
  let renderData;

  for (const line of lore) {
    const metadata = decodeMetadata(line);
    if (metadata) {
      networkId = metadata.networkId;
      itemKey = metadata.itemKey;
      continue;
    }

    const renderMetadata = decodeRenderMetadata(line);
    if (renderMetadata) {
      renderData = renderMetadata;
      if (networkId === undefined) networkId = renderMetadata.networkId;
      if (itemKey === undefined) itemKey = renderMetadata.itemKey;
      continue;
    }

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
  return {
    networkId,
    itemKey,
    entityId: renderData?.entityId,
    slot: renderData?.slot,
  };
}
