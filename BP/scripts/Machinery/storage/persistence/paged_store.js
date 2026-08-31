const PAGE_TARGET_BYTES = 24_000;
export const PAGE_HARD_LIMIT_BYTES = 28_000;
const PAGED_SCHEMA_VERSION = 2;

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function hashString(value) {
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x85ebca6b) >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

export function splitUtf8Pages(value, targetBytes = PAGE_TARGET_BYTES) {
  const text = String(value ?? "");
  const limit = Math.max(1, Math.min(PAGE_HARD_LIMIT_BYTES - 1, Math.floor(Number(targetBytes) || PAGE_TARGET_BYTES)));
  if (text.length === 0) return [""];

  const pages = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    let charBytes;
    let width = 1;
    if (code < 0x80) charBytes = 1;
    else if (code < 0x800) charBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charBytes = 4;
        width = 2;
      } else charBytes = 3;
    } else charBytes = 3;

    if (bytes > 0 && bytes + charBytes > limit) {
      pages.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += charBytes;
    if (width === 2) index += 1;
  }
  pages.push(text.slice(start));
  return pages;
}

function getManifestKey(baseKey, slot) {
  return `${baseKey}:m${slot}`;
}

function getPageKey(baseKey, generation, page) {
  return `${baseKey}:g${generation}:p${page}`;
}

function parseManifest(raw) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const manifest = JSON.parse(raw);
    if (manifest?.schema !== PAGED_SCHEMA_VERSION) return undefined;
    if (!Number.isSafeInteger(manifest.generation) || manifest.generation <= 0) return undefined;
    if (!Number.isSafeInteger(manifest.pageCount) || manifest.pageCount <= 0) return undefined;
    if (!Array.isArray(manifest.pageHashes) || manifest.pageHashes.length !== manifest.pageCount) return undefined;
    return manifest;
  } catch {
    return undefined;
  }
}

function readGeneration(target, baseKey, manifest) {
  const pages = [];
  for (let page = 0; page < manifest.pageCount; page++) {
    const raw = target.getDynamicProperty(getPageKey(baseKey, manifest.generation, page));
    if (typeof raw !== "string" || hashString(raw) !== manifest.pageHashes[page]) return undefined;
    pages.push(raw);
  }
  const json = pages.join("");
  if (utf8ByteLength(json) !== manifest.byteLength || hashString(json) !== manifest.documentHash) return undefined;
  try {
    return { value: JSON.parse(json), manifest };
  } catch {
    return undefined;
  }
}

export function readPagedJson(target, baseKey) {
  const rawHead = target.getDynamicProperty(`${baseKey}:h`);
  const head = rawHead === "a" || rawHead === "b" ? rawHead : undefined;

  // A valid head is authoritative. A newer inactive manifest may be a fully
  // written snapshot whose final head flip was interrupted.
  if (head) {
    const manifest = parseManifest(target.getDynamicProperty(getManifestKey(baseKey, head)));
    if (manifest && Number(manifest.transactionId ?? 0) === 0) {
      const result = readGeneration(target, baseKey, manifest);
      if (result) return { ...result, slot: head };
    }
  }

  // If the head itself or its generation is damaged, validate both slots and
  // recover the highest committed revision instead of assuming slot A.
  const candidates = ["a", "b"]
    .filter((slot) => slot !== head)
    .map((slot) => ({
      slot,
      manifest: parseManifest(target.getDynamicProperty(getManifestKey(baseKey, slot))),
    }))
    .filter(({ manifest }) => manifest && Number(manifest.transactionId ?? 0) === 0)
    .sort((left, right) =>
      (right.manifest.revision ?? 0) - (left.manifest.revision ?? 0)
      || right.manifest.generation - left.manifest.generation);

  for (const { slot, manifest } of candidates) {
    const result = readGeneration(target, baseKey, manifest);
    if (result) return { ...result, slot };
  }
  return undefined;
}

function createWritePlan(target, baseKey, value, metadata = {}, revision = 0) {
  const json = JSON.stringify(value);
  const pages = splitUtf8Pages(json);
  for (const page of pages) {
    if (utf8ByteLength(page) >= PAGE_HARD_LIMIT_BYTES) throw new Error("page_too_large");
  }

  const currentA = parseManifest(target.getDynamicProperty(getManifestKey(baseKey, "a")));
  const currentB = parseManifest(target.getDynamicProperty(getManifestKey(baseKey, "b")));
  const generation = Math.max(currentA?.generation ?? 0, currentB?.generation ?? 0) + 1;
  const head = target.getDynamicProperty(`${baseKey}:h`) === "b" ? "b" : "a";
  const slot = head === "a" ? "b" : "a";
  const supersededManifest = slot === "a" ? currentA : currentB;
  const manifest = {
    schema: PAGED_SCHEMA_VERSION,
    revision: Math.max(0, Math.floor(Number(revision) || 0)),
    generation,
    pageCount: pages.length,
    byteLength: utf8ByteLength(json),
    pageHashes: pages.map(hashString),
    documentHash: hashString(json),
    transactionId: 0,
    metadata,
  };
  return { pages, generation, slot, manifest, supersededManifest };
}

function finishWrite(target, baseKey, plan) {
  for (let page = 0; page < plan.pages.length; page++) {
    const raw = target.getDynamicProperty(getPageKey(baseKey, plan.generation, page));
    if (typeof raw !== "string" || hashString(raw) !== plan.manifest.pageHashes[page]) {
      throw new Error("page_hash_mismatch");
    }
  }
  const manifestJson = JSON.stringify(plan.manifest);
  if (utf8ByteLength(manifestJson) >= PAGE_HARD_LIMIT_BYTES) throw new Error("manifest_too_large");
  target.setDynamicProperty(getManifestKey(baseKey, plan.slot), manifestJson);
  target.setDynamicProperty(`${baseKey}:h`, plan.slot);
  // Both current manifests remain recoverable. Only the generation displaced
  // from the inactive slot is now unreferenced and safe to collect.
  if (plan.supersededManifest && plan.supersededManifest.generation !== plan.generation) {
    try {
      for (let page = 0; page < plan.supersededManifest.pageCount; page++) {
        target.setDynamicProperty(
          getPageKey(baseKey, plan.supersededManifest.generation, page),
          undefined,
        );
      }
    } catch (error) {
      console.warn(`[DigitalStorage] Unable to collect unreferenced pages for ${baseKey}: ${error?.message ?? error}`);
    }
  }
  return plan.manifest;
}

export function writePagedJson(target, baseKey, value, options = {}) {
  const plan = createWritePlan(target, baseKey, value, options.metadata, options.revision);
  for (let page = 0; page < plan.pages.length; page++) {
    target.setDynamicProperty(getPageKey(baseKey, plan.generation, page), plan.pages[page]);
  }
  return finishWrite(target, baseKey, plan);
}

export function updatePagedMetadata(target, baseKey, metadata, revision) {
  const current = readPagedJson(target, baseKey);
  if (!current) return undefined;
  const head = current.slot;
  const manifest = {
    ...current.manifest,
    revision: Math.max(current.manifest.revision ?? 0, Math.floor(Number(revision) || 0)),
    transactionId: 0,
    metadata,
  };
  const manifestJson = JSON.stringify(manifest);
  if (utf8ByteLength(manifestJson) >= PAGE_HARD_LIMIT_BYTES) throw new Error("manifest_too_large");
  target.setDynamicProperty(getManifestKey(baseKey, head), manifestJson);
  target.setDynamicProperty(`${baseKey}:h`, head);
  return manifest;
}

export function* writePagedJsonJob(target, baseKey, value, options = {}) {
  const pagesPerTick = Math.max(1, Math.floor(Number(options.pagesPerTick) || 2));
  const plan = createWritePlan(target, baseKey, value, options.metadata, options.revision);
  let written = 0;
  for (let page = 0; page < plan.pages.length; page++) {
    target.setDynamicProperty(getPageKey(baseKey, plan.generation, page), plan.pages[page]);
    written += 1;
    if (written >= pagesPerTick) {
      written = 0;
      yield;
    }
  }
  return finishWrite(target, baseKey, plan);
}

export function deletePagedJson(target, baseKey) {
  const manifests = ["a", "b"].map((slot) => parseManifest(target.getDynamicProperty(getManifestKey(baseKey, slot))));
  for (const manifest of manifests) {
    if (!manifest) continue;
    for (let page = 0; page < manifest.pageCount; page++) {
      target.setDynamicProperty(getPageKey(baseKey, manifest.generation, page), undefined);
    }
  }
  target.setDynamicProperty(getManifestKey(baseKey, "a"), undefined);
  target.setDynamicProperty(getManifestKey(baseKey, "b"), undefined);
  target.setDynamicProperty(`${baseKey}:h`, undefined);
}

export { hashString, utf8ByteLength };
