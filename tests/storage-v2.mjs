import assert from 'node:assert/strict';
import {
  getEntriesStorageSummary,
  getEntryStorageDelta,
  getEntryStorageUnits,
  getMaxInsertAmount,
} from '../BP/scripts/Machinery/storage/storage_cost.js';
import {
  PAGE_HARD_LIMIT_BYTES,
  readPagedJson,
  splitUtf8Pages,
  updatePagedMetadata,
  utf8ByteLength,
  writePagedJson,
  writePagedJsonJob,
} from '../BP/scripts/Machinery/storage/persistence/paged_store.js';
import {
  formatCompactCount,
  formatStorageBytes,
  formatStoragePercent,
} from '../BP/scripts/Machinery/storage/storage_format.js';
import {
  BASE_WIRELESS_RANGE,
  checkWirelessAccess,
  getWirelessAccessFromUpgrade,
  MAX_RANGE_UPGRADES,
  parseWirelessCenterKey,
  RANGE_PER_UPGRADE,
} from '../BP/scripts/Machinery/storage/wireless_access.js';

class DynamicPropertyTarget {
  properties = new Map();

  getDynamicProperty(key) {
    return this.properties.get(key);
  }

  setDynamicProperty(key, value) {
    if (value === undefined) this.properties.delete(key);
    else this.properties.set(key, value);
  }

  getDynamicPropertyIds() {
    return [...this.properties.keys()];
  }
}

assert.equal(getEntryStorageUnits('minecraft:stone', 0), 0);
assert.equal(getEntryStorageUnits('minecraft:stone', 1), 9);
assert.equal(getEntryStorageUnits('minecraft:stone', 8), 9);
assert.equal(getEntryStorageUnits('minecraft:stone', 9), 10);
assert.equal(getEntryStorageUnits('minecraft:stone', 64), 16);
assert.equal(getEntryStorageUnits('ucds:item:abc', 1), 17);
assert.equal(getEntryStorageUnits('ucds:vault:1:0', 1), 64);
assert.equal(getEntryStorageUnits('ucds:vault:1:0', 2), Number.POSITIVE_INFINITY);
assert.equal(getEntryStorageDelta('minecraft:stone', 1, 8), 0);
assert.equal(getEntryStorageDelta('minecraft:stone', 8, 9), 1);
assert.equal(getMaxInsertAmount('minecraft:stone', 0, 9, 64), 8);
assert.equal(getMaxInsertAmount('minecraft:stone', 1, 0, 64), 7);
assert.equal(getMaxInsertAmount('ucds:vault:1:0', 0, 63, 1), 0);
assert.equal(getMaxInsertAmount('ucds:vault:1:0', 0, 64, 1), 1);
assert.equal(formatCompactCount(1_000), '1k');
assert.equal(formatCompactCount(30), '30');
assert.equal(formatStorageBytes(1_024), '1 KB');
assert.equal(formatStorageBytes(4_096), '4 KB');
assert.equal(formatStorageBytes(409_600), '400 KB');
assert.equal(formatStoragePercent(1_024, 4_096), '25%');
assert.equal(BASE_WIRELESS_RANGE, 64);
assert.equal(RANGE_PER_UPGRADE, 128);
assert.equal(MAX_RANGE_UPGRADES, 8);
assert.deepEqual(getWirelessAccessFromUpgrade(undefined), {
  range: 64,
  dimensional: false,
  level: 0,
});
assert.deepEqual(getWirelessAccessFromUpgrade({ typeId: 'utilitycraft:range_upgrade', amount: 8 }), {
  range: 1088,
  dimensional: false,
  level: 8,
});
assert.deepEqual(getWirelessAccessFromUpgrade({ typeId: 'utilitycraft:range_upgrade', amount: 64 }), {
  range: 1088,
  dimensional: false,
  level: 8,
});
assert.deepEqual(getWirelessAccessFromUpgrade({ typeId: 'utilitycraft:dimensional_range_upgrade', amount: 1 }), {
  range: 64,
  dimensional: true,
  level: 8,
});
assert.deepEqual(parseWirelessCenterKey('custom:moon:0,64,-2'), {
  dimensionId: 'custom:moon',
  location: { x: 0.5, y: 64.5, z: -1.5 },
});

const rangedNetwork = {
  online: true,
  center: 'minecraft:overworld:0,64,0',
  wirelessRange: 64,
  wirelessDimensional: false,
};
assert.deepEqual(checkWirelessAccess(rangedNetwork, 'minecraft:overworld', { x: 64.5, y: 64.5, z: 0.5 }), { allowed: true });
assert.deepEqual(checkWirelessAccess(rangedNetwork, 'minecraft:overworld', { x: 64.51, y: 64.5, z: 0.5 }), { allowed: false, reason: 'range' });
assert.deepEqual(checkWirelessAccess(rangedNetwork, 'minecraft:nether', { x: 0.5, y: 64.5, z: 0.5 }), { allowed: false, reason: 'dimension' });
assert.deepEqual(checkWirelessAccess({ ...rangedNetwork, wirelessDimensional: true }, 'minecraft:the_end', { x: 100000, y: 80, z: 100000 }), { allowed: true });

assert.deepEqual(getEntriesStorageSummary({
  'minecraft:stone': 64,
  'minecraft:dirt': 1,
}), {
  valid: true,
  usedUnits: 25,
  itemCount: 65,
  typeCount: 2,
});

const unicode = 'á漢😀'.repeat(20_000);
const chunks = splitUtf8Pages(unicode);
assert.equal(chunks.join(''), unicode);
assert.ok(chunks.length > 1);
assert.ok(chunks.every((chunk) => utf8ByteLength(chunk) < PAGE_HARD_LIMIT_BYTES));

const target = new DynamicPropertyTarget();
const first = { version: 1, text: 'first', entries: [['minecraft:stone', 64]] };
writePagedJson(target, 'test:record', first, { revision: 1, metadata: { owner: 1 } });
assert.deepEqual(readPagedJson(target, 'test:record').value, first);

const interruptedValue = { version: 99, text: unicode };
const interruptedJob = writePagedJsonJob(target, 'test:record', interruptedValue, { pagesPerTick: 1 });
assert.equal(interruptedJob.next().done, false);
assert.deepEqual(readPagedJson(target, 'test:record').value, first);

const second = { version: 2, text: unicode, entries: [['minecraft:dirt', 4096]] };
writePagedJson(target, 'test:record', second, { revision: 2, metadata: { owner: 2 } });
assert.deepEqual(readPagedJson(target, 'test:record').value, second);
assert.ok([...target.properties.values()]
  .filter((value) => typeof value === 'string')
  .every((value) => utf8ByteLength(value) < PAGE_HARD_LIMIT_BYTES));

updatePagedMetadata(target, 'test:record', { owner: 0 }, 3);
assert.equal(readPagedJson(target, 'test:record').manifest.metadata.owner, 0);

const head = target.getDynamicProperty('test:record:h');
target.setDynamicProperty('test:record:h', 'corrupt');
assert.deepEqual(readPagedJson(target, 'test:record').value, second);
target.setDynamicProperty('test:record:h', head);

const activeManifest = JSON.parse(target.getDynamicProperty(`test:record:m${head}`));
target.setDynamicProperty(`test:record:g${activeManifest.generation}:p0`, 'corrupt');
assert.deepEqual(readPagedJson(target, 'test:record').value, first);

const collectedTarget = new DynamicPropertyTarget();
writePagedJson(collectedTarget, 'test:gc', { revision: 1 }, { revision: 1 });
writePagedJson(collectedTarget, 'test:gc', { revision: 2 }, { revision: 2 });
writePagedJson(collectedTarget, 'test:gc', { revision: 3 }, { revision: 3 });
const retainedGenerations = new Set(
  collectedTarget.getDynamicPropertyIds()
    .map((key) => /^test:gc:g(\d+):p\d+$/.exec(key)?.[1])
    .filter(Boolean),
);
assert.deepEqual([...retainedGenerations].sort(), ['2', '3']);
assert.equal(readPagedJson(collectedTarget, 'test:gc').value.revision, 3);

console.log('Storage V2 tests passed.');
