// Firestore boundary: persisted Korean schema <-> existing domain objects.
// Only this module imports the Firestore data SDK; engines never see storage names.
import * as sdk from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import {
  collectionPath,
  documentPath,
  logicalId,
  encodeData,
  decodeData,
  fieldPath,
} from './schema.js?v=db-schema-5';
const kinds = new WeakMap();
const rawSnapshots = new WeakMap();
function tag(ref, kind) {
  kinds.set(ref, kind);
  return ref;
}
function kindOf(ref) {
  const kind = kinds.get(ref);
  if (!kind) throw new Error('A schema-aware Firestore reference is required');
  return kind;
}
export function doc(db, kind, id) {
  return tag(sdk.doc(db, documentPath(kind, id)), kind);
}
export function collection(db, kind) {
  return tag(sdk.collection(db, collectionPath(kind)), kind);
}
export function query(ref, ...constraints) {
  return tag(sdk.query(ref, ...constraints), kindOf(ref));
}
export const where = (field, op, value) =>
  sdk.where(fieldPath(field), op, value);
export const orderBy = (field, ...args) =>
  sdk.orderBy(fieldPath(field), ...args);
export const limit = sdk.limit;
export const startAfter = (...values) =>
  sdk.startAfter(...values.map((value) => rawSnapshots.get(value) ?? value));
function snapshot(raw, kind) {
  tag(raw.ref, kind);
  const result = {
    id: logicalId(kind, raw.id),
    ref: raw.ref,
    metadata: raw.metadata,
    exists: () => raw.exists(),
    data: () => decodeData(kind, raw.data()),
    get: (field) => raw.get(fieldPath(field)),
  };
  rawSnapshots.set(result, raw);
  return result;
}
function querySnapshot(raw, kind) {
  const docs = raw.docs.map((item) => snapshot(item, kind));
  return {
    docs,
    size: raw.size,
    empty: raw.empty,
    metadata: raw.metadata,
    query: raw.query,
    forEach: (callback) => docs.forEach(callback),
  };
}
export const getDoc = async (ref) =>
  snapshot(await sdk.getDoc(ref), kindOf(ref));
export const getDocs = async (ref) =>
  querySnapshot(await sdk.getDocs(ref), kindOf(ref));
export const setDoc = (ref, data, ...options) =>
  sdk.setDoc(ref, encodeData(kindOf(ref), data), ...options);
export const updateDoc = (ref, data) =>
  sdk.updateDoc(ref, encodeData(kindOf(ref), data));
export const deleteDoc = (ref) => sdk.deleteDoc(ref);
function writer(raw) {
  const wrapped = {
    set(ref, data, ...options) {
      raw.set(ref, encodeData(kindOf(ref), data), ...options);
      return wrapped;
    },
    update(ref, data) {
      raw.update(ref, encodeData(kindOf(ref), data));
      return wrapped;
    },
    delete(ref) {
      raw.delete(ref);
      return wrapped;
    },
  };
  if (raw.get)
    wrapped.get = async (ref) => snapshot(await raw.get(ref), kindOf(ref));
  if (raw.commit) wrapped.commit = () => raw.commit();
  return wrapped;
}
export const writeBatch = (db) => writer(sdk.writeBatch(db));
export const runTransaction = (db, callback, ...options) =>
  sdk.runTransaction(db, (raw) => callback(writer(raw)), ...options);
export function onSnapshot(ref, options, onNext, onError) {
  if (typeof options === 'function') {
    onError = onNext;
    onNext = options;
    options = {};
  }
  return sdk.onSnapshot(
    ref,
    options,
    (raw) => onNext(snapshot(raw, kindOf(ref))),
    onError,
  );
}
export const {
  Timestamp,
  serverTimestamp,
  connectFirestoreEmulator,
  getFirestore,
} = sdk;
