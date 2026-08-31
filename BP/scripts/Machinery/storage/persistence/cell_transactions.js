import { system, world } from '@minecraft/server';
import { writeCellRecord } from '../cell_store.js';
import { deletePagedJson, readPagedJson, writePagedJson } from './paged_store.js';

const NEXT_TRANSACTION_ID = 'ucds:v2:next_tx';
const TRANSACTION_INDEX_PREFIX = 'ucds:v2:txi:';
const TRANSACTION_PREFIX = 'ucds:v2:tx:';
const INDEX_BUCKET_SIZE = 64;
const pendingCellIds = new Set();

function normalizeId(value) {
  const id = Math.floor(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function getIndexKey(transactionId) {
  return `${TRANSACTION_INDEX_PREFIX}${Math.floor(transactionId / INDEX_BUCKET_SIZE)}`;
}

function readIds(key) {
  const raw = world.getDynamicProperty(key);
  if (typeof raw !== 'string') return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? [...new Set(ids.map(normalizeId).filter(Boolean))] : [];
  } catch {
    return [];
  }
}

function addTransactionId(transactionId) {
  const key = getIndexKey(transactionId);
  const ids = readIds(key);
  if (!ids.includes(transactionId)) ids.push(transactionId);
  world.setDynamicProperty(key, JSON.stringify(ids.sort((a, b) => a - b)));
}

function removeTransactionId(transactionId) {
  const key = getIndexKey(transactionId);
  const ids = readIds(key).filter((id) => id !== transactionId);
  world.setDynamicProperty(key, ids.length > 0 ? JSON.stringify(ids) : undefined);
}

function allocateTransactionId() {
  const current = Math.max(1, normalizeId(world.getDynamicProperty(NEXT_TRANSACTION_ID)) || 1);
  if (!Number.isSafeInteger(current + 1)) throw new Error('transaction_id_exhausted');
  world.setDynamicProperty(NEXT_TRANSACTION_ID, current + 1);
  return current;
}

function getTransactionIds() {
  const ids = new Set();
  for (const key of world.getDynamicPropertyIds()) {
    if (key.startsWith(TRANSACTION_INDEX_PREFIX)) {
      for (const id of readIds(key)) ids.add(id);
      continue;
    }
    const intent = /^ucds:v2:tx:(\d+):(h|ma|mb|g\d+:p\d+)$/.exec(key);
    const intentId = intent ? normalizeId(intent[1]) : 0;
    if (intentId) ids.add(intentId);
  }
  return [...ids].sort((a, b) => a - b);
}

function getTransactionKey(transactionId) {
  return `${TRANSACTION_PREFIX}${transactionId}`;
}

function applyTransaction(transaction) {
  const source = transaction?.source;
  const destination = transaction?.destination;
  if (!source?.cellId || !destination?.cellId) throw new Error('invalid_cell_transaction');
  writeCellRecord(destination.cellId, destination.record);
  writeCellRecord(source.cellId, source.record);
}

export function commitCellTransaction(source, destination) {
  const transactionId = allocateTransactionId();
  const transaction = {
    schema: 2,
    transactionId,
    state: 'prepared',
    source,
    destination,
  };
  writePagedJson(world, getTransactionKey(transactionId), transaction, { revision: transactionId });
  addTransactionId(transactionId);
  pendingCellIds.add(source.cellId);
  pendingCellIds.add(destination.cellId);
  try {
    applyTransaction(transaction);
    deletePagedJson(world, getTransactionKey(transactionId));
    removeTransactionId(transactionId);
    pendingCellIds.delete(source.cellId);
    pendingCellIds.delete(destination.cellId);
    return true;
  } catch (error) {
    console.warn(`[DigitalStorage] Cell transaction ${transactionId} remains pending: ${error?.message ?? error}`);
    system.runJob(recoverCellTransactionsJob());
    return false;
  }
}

export function hasPendingCellTransaction(cellId) {
  return pendingCellIds.has(normalizeId(cellId));
}

export function* recoverCellTransactionsJob({ transactionsPerTick = 1 } = {}) {
  const budget = Math.max(1, Math.floor(Number(transactionsPerTick) || 1));
  let processed = 0;
  for (const transactionId of getTransactionIds()) {
    const stored = readPagedJson(world, getTransactionKey(transactionId));
    if (!stored?.value) {
      console.warn(`[DigitalStorage] Cell transaction ${transactionId} is unreadable; storage startup remains locked.`);
      throw new Error(`cell_transaction_${transactionId}_unreadable`);
    }
    try {
      const sourceId = normalizeId(stored.value.source?.cellId);
      const destinationId = normalizeId(stored.value.destination?.cellId);
      if (!sourceId || !destinationId) throw new Error('invalid_cell_transaction');
      pendingCellIds.add(sourceId);
      pendingCellIds.add(destinationId);
      applyTransaction(stored.value);
      deletePagedJson(world, getTransactionKey(transactionId));
      removeTransactionId(transactionId);
      pendingCellIds.delete(sourceId);
      pendingCellIds.delete(destinationId);
    } catch (error) {
      console.warn(`[DigitalStorage] Unable to recover cell transaction ${transactionId}: ${error?.message ?? error}`);
      throw error;
    }
    processed += 1;
    if (processed >= budget) {
      processed = 0;
      yield;
    }
  }
}
