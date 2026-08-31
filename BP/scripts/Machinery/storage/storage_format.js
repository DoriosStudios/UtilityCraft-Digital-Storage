function trimDecimals(value) {
  return value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

export function formatCompactCount(value) {
  const amount = Math.max(0, Math.floor(Number(value) || 0));
  if (amount < 1000) return String(amount);

  const units = ["k", "M", "B", "T"];
  let scaled = amount;
  let unit = "";
  for (const nextUnit of units) {
    if (scaled < 1000) break;
    scaled /= 1000;
    unit = nextUnit;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${trimDecimals(scaled.toFixed(decimals))}${unit}`;
}

export function formatStorageBytes(value) {
  const bytes = Math.max(0, Math.floor(Number(value) || 0));
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    if (scaled < 1024) break;
    scaled /= 1024;
    unit = nextUnit;
  }
  const decimals = Number.isInteger(scaled) ? 0 : scaled >= 10 ? 1 : 2;
  return `${trimDecimals(scaled.toFixed(decimals))} ${unit}`;
}

export function formatStoragePercent(used, capacity) {
  const maximum = Math.max(0, Math.floor(Number(capacity) || 0));
  if (maximum <= 0) return "0%";
  const percent = Math.max(0, Math.min(100, ((Number(used) || 0) / maximum) * 100));
  const decimals = Number.isInteger(percent) ? 0 : 1;
  return `${trimDecimals(percent.toFixed(decimals))}%`;
}
