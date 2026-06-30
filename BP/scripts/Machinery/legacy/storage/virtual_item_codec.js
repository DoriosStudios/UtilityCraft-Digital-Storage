const SECTION = "\u00A7";
const LEGACY_NETWORK_PREFIX = `${SECTION}0${SECTION}1${SECTION}2${SECTION}3`;
const LEGACY_ITEM_KEY_PREFIX = `${SECTION}0ucds_key:`;
const METADATA_PREFIX = `${SECTION}n${SECTION}e${SECTION}k${SECTION}r`;
const RENDER_METADATA_PREFIX = `${SECTION}r${SECTION}e${SECTION}n${SECTION}d`;
export const VIRTUAL_COUNT_NAME_PREFIX = `${SECTION}0${SECTION}9${SECTION}0${SECTION}f`;
const COUNT_LABEL_WIDTH = 6;
const COUNT_LABEL_PAD_CHAR = "a";
const VIRTUAL_HOVER_CUT_WIDTH = 48;
const VIRTUAL_HOVER_PAD_CHAR = "b";

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

function stripFormatting(text = "") {
  return String(text).replace(/\u00A7./g, "");
}

function titleFromTypeId(typeId = "") {
  const raw = String(typeId).split(":").pop() || String(typeId);
  return raw
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function getOriginalDisplayName(item) {
  const rawName = String(item?.nameTag || "");
  if (rawName.startsWith(VIRTUAL_COUNT_NAME_PREFIX)) {
    return stripFormatting(rawName.slice(VIRTUAL_COUNT_NAME_PREFIX.length + COUNT_LABEL_WIDTH))
      .replace(/^[\sab]+/u, "");
  }

  return stripFormatting(rawName || titleFromTypeId(item?.typeId));
}

export function formatVirtualCountLabel(value) {
  const amount = Math.max(0, Math.floor(Number(value) || 0));
  if (amount < 1000) return amount.toString();

  const units = [
    ["E", 1000000000000000000],
    ["P", 1000000000000000],
    ["T", 1000000000000],
    ["B", 1000000000],
    ["M", 1000000],
    ["k", 1000],
  ];

  for (const [suffix, base] of units) {
    if (amount < base) continue;
    const scaled = amount / base;
    const valueText = scaled < 100
      ? scaled.toFixed(1).replace(/\.0$/, "")
      : Math.floor(scaled).toString();
    return `${valueText}${suffix}`;
  }

  return amount.toString();
}

function getVirtualDisplayName(item, count) {
  const label = formatVirtualCountLabel(count)
    .slice(0, COUNT_LABEL_WIDTH)
    .padEnd(COUNT_LABEL_WIDTH, COUNT_LABEL_PAD_CHAR);
  const hoverPaddingWidth = Math.max(
    0,
    VIRTUAL_HOVER_CUT_WIDTH - VIRTUAL_COUNT_NAME_PREFIX.length - COUNT_LABEL_WIDTH,
  );
  const originalName = getOriginalDisplayName(item);
  return `${VIRTUAL_COUNT_NAME_PREFIX}${label}${VIRTUAL_HOVER_PAD_CHAR.repeat(hoverPaddingWidth)}${originalName}`;
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

  const data = {
    n: Math.max(0, Math.floor(Number(networkId) || 0)),
    k: itemKey,
    e: entityId,
    s: slotIndex,
  };
  return encodeHiddenPayload(RENDER_METADATA_PREFIX, data);
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
    count: Number.isInteger(data.c) ? data.c : undefined,
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
  if (renderContext?.count !== undefined) {
    item.nameTag = getVirtualDisplayName(item, renderContext.count);
  }
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
  let count;

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
      if (count === undefined) count = renderMetadata.count;
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
    count,
    entityId: renderData?.entityId,
    slot: renderData?.slot,
  };
}
