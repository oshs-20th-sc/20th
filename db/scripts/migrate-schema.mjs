// Copy the legacy root collections into the canonical event hierarchy.
// Sources remain intact so the cutover can be rolled back without data loss.
import { link, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { privateOutput } from './private-files.mjs';
import {
  COLLECTIONS,
  FIELDS,
  PARENT_DOCUMENTS,
  documentPath,
  encodeData,
  legacyDestination,
} from '../schema.js';

const pageSize = 250;
const maxAtomicComponent = 200;
const rootCollectionPattern = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const legacyCollections = new Set([
  'admins','challenges','letterLogs','letters','moderationLogs','publicLetters',
  'receipts','settings','students','typingResults','letterTrash',
]);
const canonicalRoots = new Set(Object.values(COLLECTIONS).map((path)=>path.split('/')[0]));

function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('INTEGER_OUT_OF_RANGE');
  return number;
}

function timestampMarker(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) throw new Error('INVALID_FIRESTORE_TIMESTAMP');
  const millis = Date.parse(`${match[1]}.${(match[2] ?? '').slice(0, 3).padEnd(3, '0')}${match[3]}`);
  if (!Number.isFinite(millis)) throw new Error('INVALID_FIRESTORE_TIMESTAMP');
  return {
    __firestoreTimestamp: true,
    seconds: Math.floor(millis / 1000),
    nanoseconds: Number((match[2] ?? '').padEnd(9, '0').slice(0, 9)),
  };
}

export function decodeValue(value, depth = 0) {
  if (depth > 20) throw new Error('FIRESTORE_VALUE_TOO_DEEP');
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return safeInteger(value.integerValue);
  if ('doubleValue' in value) {
    const number = Number(value.doubleValue);
    if (!Number.isFinite(number)) throw new Error('INVALID_FIRESTORE_NUMBER');
    return number;
  }
  if ('timestampValue' in value) return timestampMarker(value.timestampValue);
  if ('arrayValue' in value)
    return (value.arrayValue.values ?? []).map((entry) => decodeValue(entry, depth + 1));
  if ('mapValue' in value)
    return Object.fromEntries(Object.entries(value.mapValue.fields ?? {})
      .map(([key, entry]) => [key, decodeValue(entry, depth + 1)]));
  throw new Error('UNSUPPORTED_FIRESTORE_VALUE');
}

function encodeTimestamp(value) {
  const seconds = value.seconds;
  const nanos = String(value.nanoseconds).padStart(9, '0');
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${nanos}Z`);
}

export function encodeValue(value, depth = 0) {
  if (depth > 20) throw new Error('FIRESTORE_VALUE_TOO_DEEP');
  if (value === null) return { nullValue: null };
  if (value && typeof value === 'object' && value.__firestoreTimestamp === true)
    return { timestampValue: encodeTimestamp(value) };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVALID_FIRESTORE_NUMBER');
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map((entry) => encodeValue(entry, depth + 1)) } };
  if (value && typeof value === 'object')
    return { mapValue: { fields: Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key, encodeValue(entry, depth + 1)])) } };
  throw new Error('UNSUPPORTED_FIRESTORE_VALUE');
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function encodeFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encodeValue(value)]));
}

function nestedKind(kind,key){
  if(kind==='letterTrash'&&key==='letter')return 'letters';
  if(kind==='letterLogs'&&['before','after'].includes(key))return 'letters';
  return null;
}

function renameRawFields(kind,fields,rootFields=fields){
  const renamed={};
  for(const [key,value] of Object.entries(fields??{})){
    let next=FIELDS[key]??key;
    if(kind==='typingResults'&&key==='participantId'&&rootFields?.entry_mode?.stringValue!=='record')next='이전참가자ID';
    if(Object.hasOwn(renamed,next))throw new Error('FIELD_RENAME_COLLISION');
    const nested=nestedKind(kind,key);
    const nextValue=nested&&value?.mapValue?.fields
      ?{mapValue:{...value.mapValue,fields:renameRawFields(nested,value.mapValue.fields,value.mapValue.fields)}}
      :value;
    renamed[next]=nextValue;
  }
  return renamed;
}

function logicalCollection(collection, id, data) {
  if (collection === 'admins' || collection === 'settings' || collection === 'challenges' ||
      collection === 'letters' || collection === 'typingResults' || collection === 'publicLetters' ||
      collection === 'letterTrash' || collection === 'letterLogs' || collection === 'receipts')
    return legacyDestination(collection, id, data);
  if (collection === 'students') return { kind: 'legacyStudents', id, path: documentPath('legacyStudents', id) };
  if (collection === 'moderationLogs') return { kind: 'legacyModerationLogs', id, path: documentPath('legacyModerationLogs', id) };
  throw new Error('UNSUPPORTED_SOURCE_COLLECTION');
}

function uniqueByPath(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.path)) throw new Error('DUPLICATE_MIGRATION_DESTINATION');
    seen.set(row.path, row);
  }
  return rows;
}

export function prepareRows(sourceDocuments) {
  const rows = sourceDocuments.map((document) => {
    const sourceCollection = document.name.split('/').at(-2);
    const id = document.name.split('/').at(-1);
    const sourceData = decodeFields(document.fields);
    const destination = logicalCollection(sourceCollection, id, sourceData);
    encodeData(destination.kind, sourceData); // Validate every source key before writing.
    return {
      kind: destination.kind,
      id: destination.id,
      path: destination.path,
      fields: renameRawFields(destination.kind,document.fields,document.fields),
      sourceName: document.name,
      sourceUpdateTime: document.updateTime,
      logicalSourceCollection: sourceCollection,
      sourceData,
    };
  });
  return uniqueByPath(rows);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function fieldsEqual(left = {}, right = {}) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function migrationPlan(rows, destinations, { includeParents = true } = {}) {
  const plan=rows.map((row) => {
    const existing = destinations.get(row.path);
    return {
      kind: row.kind,
      id: row.id,
      path: row.path,
      sourceCollection: row.logicalSourceCollection,
      status: !existing ? 'create' : fieldsEqual(existing.fields, row.fields) ? 'unchanged' : 'conflict',
    };
  });
  if(includeParents)for(const [path,data] of Object.entries(PARENT_DOCUMENTS)){
    const existing=destinations.get(path),fields=encodeFields(data);
    plan.push({kind:'parent',id:path.split('/').at(-1),path,
      status:!existing?'create':fieldsEqual(existing.fields,fields)?'unchanged':'preserved'});
  }
  return plan;
}

function unionFind(rows) {
  const parent = rows.map((_, index) => index);
  const root = (value) => parent[value] === value ? value : (parent[value] = root(parent[value]));
  const join = (left, right) => { parent[root(right)] = root(left); };
  const idIndex = new Map();
  rows.forEach((row, index) => {
    const id = row.id;
    if (idIndex.has(id)) join(index, idIndex.get(id));
    else idIndex.set(id, index);
  });
  const resultById = new Map(rows.filter((row) => row.kind === 'typingResults').map((row, index) => [row.id, rows.indexOf(row)]));
  rows.forEach((row, index) => {
    if (row.kind === 'typingEntries' && resultById.has(row.sourceData.result_id)) join(index, resultById.get(row.sourceData.result_id));
    if (row.kind === 'letterLogs' && idIndex.has(row.sourceData.letter_id)) join(index, idIndex.get(row.sourceData.letter_id));
  });
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });
  return [...groups.values()];
}

export function backupFromDocuments(project, docs) {
  const collections = {};
  const updateTimes = {};
  const rawDocuments = {};
  for (const document of docs) {
    const collection = document.name.split('/').at(-2);
    if (!['admins','challenges','letterLogs','letters','moderationLogs','publicLetters','receipts','settings','students','typingResults','letterTrash'].includes(collection))
      throw new Error('UNSUPPORTED_SOURCE_COLLECTION');
    const id = document.name.split('/').at(-1);
    (collections[collection] ??= []).push({ id, data: decodeFields(document.fields) });
    updateTimes[`${collection}/${id}`] = document.updateTime;
    rawDocuments[`${collection}/${id}`] = {
      updateTime: document.updateTime,
      fields: document.fields,
    };
  }
  for (const rows of Object.values(collections)) rows.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 4,
    backend: 'firebase',
    projectId: project,
    exportedAt: new Date().toISOString(),
    includesAuthentication: false,
    collections,
    migrationSnapshot: { updateTimes, rawDocuments },
  };
}

async function writePrivateFile(path, value, {overwrite=false}={}) {
  const target = await privateOutput(resolve(path));
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, body, { flag: 'wx', mode: 0o600 });
  try {
    if(overwrite)await rename(temp,target);
    else await link(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (error.code === 'EEXIST') throw new Error('PRIVATE_OUTPUT_ALREADY_EXISTS');
    throw error;
  }
  await unlink(temp).catch(() => {});
  return target;
}

function snapshotsMatch(left,right){
  const a=left?.migrationSnapshot?.updateTimes,b=right?.migrationSnapshot?.updateTimes;
  return left?.schemaVersion===4&&left?.projectId===right?.projectId&&a&&b&&
    fieldsEqual(a,b)&&fieldsEqual(left.migrationSnapshot?.rawDocuments,right.migrationSnapshot?.rawDocuments)&&
    fieldsEqual(left.collections,right.collections);
}

async function writeOrReuseBackup(path,backup){
  try{
    if((await stat(path)).size>100*1024*1024)throw new Error('BACKUP_TOO_LARGE');
    const existing=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
    if(!snapshotsMatch(existing,backup))throw new Error('BACKUP_SOURCE_CHANGED');
    return false;
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    await writePrivateFile(path,backup);
    return true;
  }
}

async function readAllDocuments(api, project, collectionIds) {
  const docs = [];
  const base = `projects/${project}/databases/(default)/documents`;
  const unknown = collectionIds.filter((name)=>!legacyCollections.has(name) && !canonicalRoots.has(name));
  if (unknown.length) throw new Error('UNSUPPORTED_SOURCE_COLLECTION');
  for (const collection of collectionIds.filter((name)=>legacyCollections.has(name))) {
    if (!rootCollectionPattern.test(collection)) throw new Error('INVALID_ROOT_COLLECTION');
    let token = '';
    do {
      const url = `${base}/${encodeURIComponent(collection)}?pageSize=${pageSize}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const page = (await api.get(url)).body;
      docs.push(...(page.documents ?? []));
      token = page.nextPageToken ?? '';
    } while (token);
  }
  return docs;
}

function wireDocument(path, fields) {
  return {
    name: `projects/${path.includes('/') ? path.split('/').slice(0, 2).join('/') : path}`,
    fields,
  };
}

function targetName(project, path) {
  return `projects/${project}/databases/(default)/documents/${path}`;
}

async function fetchDocuments(api, project, paths, transaction) {
  const base = `projects/${project}/databases/(default)/documents`;
  const body = { documents: paths.map((path) => targetName(project, path)) };
  if (transaction) body.transaction = transaction;
  const result = await api.post(`${base}:batchGet`, body);
  return result.body;
}

async function beginTransaction(api, project) {
  const base = `projects/${project}/databases/(default)/documents`;
  return (await api.post(`${base}:beginTransaction`, {})).body.transaction;
}

async function endTransaction(api, project, transaction, writes) {
  const base = `projects/${project}/databases/(default)/documents`;
  if (writes.length) await api.post(`${base}:commit`, { transaction, writes });
  else await api.post(`${base}:rollback`, { transaction });
}

async function safeRollback(api, project, transaction) {
  const base = `projects/${project}/databases/(default)/documents`;
  await api.post(`${base}:rollback`, { transaction }).catch(() => {});
}

export async function applyComponent(api, project, rows) {
  if (rows.length > maxAtomicComponent) throw new Error('MIGRATION_COMPONENT_TOO_LARGE');
  const transaction = await beginTransaction(api, project);
  const sourcePaths = rows.map((row) => row.sourceName.split('/documents/')[1]);
  const paths = [...new Set([...sourcePaths, ...rows.map((row) => row.path)])];
  try {
    const snapshots = await fetchDocuments(api, project, paths, transaction);
    const byName = new Map(snapshots.flatMap((entry) => entry.found ? [[entry.found.name, entry.found]] : []));
    const writes = [];
    for (const row of rows) {
      const source = byName.get(targetName(project, sourcePaths[rows.indexOf(row)]));
      if (!source || source.updateTime !== row.sourceUpdateTime) throw new Error('SOURCE_CHANGED_DURING_MIGRATION');
      const target = byName.get(targetName(project, row.path));
      if (target) {
        if (!fieldsEqual(target.fields, row.fields)) throw new Error('DESTINATION_CONFLICT');
        continue;
      }
      writes.push({ update: { name: targetName(project, row.path), fields: row.fields }, currentDocument: { exists: false } });
    }
    await endTransaction(api, project, transaction, writes);
    return rows.map((row) => ({ path: row.path, status: 'created-or-unchanged' }));
  } catch (error) {
    await safeRollback(api, project, transaction);
    throw error;
  }
}

export async function migrateDocuments(api, project, rows, { apply = false } = {}) {
  const parentPaths=Object.keys(PARENT_DOCUMENTS);
  const paths = [...new Set([...rows.map((row) => row.path),...parentPaths])];
  const existing = new Map();
  for (let offset = 0; offset < paths.length; offset += pageSize) {
    const snapshots = await fetchDocuments(api, project, paths.slice(offset, offset + pageSize));
    for (const snapshot of snapshots) if (snapshot.found) existing.set(snapshot.found.name.split('/documents/')[1], snapshot.found);
  }
  const plan = migrationPlan(rows, existing);
  if (plan.some((item) => item.status === 'conflict')) throw Object.assign(new Error('DESTINATION_CONFLICT'), { plan });
  if (!apply) return { plan, applied: false };

  const parentWrites = plan.filter((item)=>item.kind==='parent'&&item.status==='create').map((item)=>({
    update:{name:targetName(project,item.path),fields:encodeFields(PARENT_DOCUMENTS[item.path])},
    currentDocument:{exists:false},
  }));
  if (parentWrites.length) {
    const transaction = await beginTransaction(api, project);
    try { await endTransaction(api, project, transaction, parentWrites); }
    catch (error) { await safeRollback(api, project, transaction); throw error; }
  }
  const groups = unionFind(rows);
  const results = [];
  for (const group of groups) results.push(...await applyComponent(api, project, group));
  return { plan, applied: true, parentsCreated: parentWrites.length, components: groups.length, results };
}

export async function cleanupLegacy(api, project, sourceDocuments, backup,{apply=false}={}) {
  if (backup?.schemaVersion !== 4 || backup?.projectId !== project ||
      backup?.migrationSnapshot?.updateTimes == null)
    throw new Error('MIGRATION_BACKUP_REQUIRED');
  const saved = new Map();
  for (const [collection, rows] of Object.entries(backup.collections ?? {}))
    for (const row of rows) saved.set(`${collection}/${row.id}`, row);
  const savedRaw = backup.migrationSnapshot.rawDocuments;
  if (!savedRaw || typeof savedRaw !== 'object' || Array.isArray(savedRaw))
    throw new Error('MIGRATION_BACKUP_INCOMPLETE');
  const sourceRows = prepareRows(sourceDocuments);
  const locations = sourceDocuments.map((document)=>{
    const collection=document.name.split('/').at(-2), id=document.name.split('/').at(-1);
    const key=`${collection}/${id}`;
    const prior=saved.get(key);
    const raw=savedRaw[key];
    if (!prior || !raw || backup.migrationSnapshot.updateTimes[key]!==document.updateTime ||
        raw.updateTime!==document.updateTime || !fieldsEqual(raw.fields,document.fields) ||
        !fieldsEqual(prior.data,decodeFields(document.fields)))
      throw new Error('LEGACY_SOURCE_CHANGED_SINCE_BACKUP');
    return {collection,id,key,document,row:sourceRows.find((row)=>row.sourceName===document.name)};
  });
  const expectedKeys=Object.keys(backup.migrationSnapshot.updateTimes).sort();
  const currentKeys=sourceDocuments.map((document)=>{
    const collection=document.name.split('/').at(-2),id=document.name.split('/').at(-1);
    return `${collection}/${id}`;
  }).sort();
  if (!fieldsEqual(expectedKeys,currentKeys) ||
      !fieldsEqual(Object.keys(savedRaw).sort(),expectedKeys))
    throw new Error('LEGACY_SOURCE_SET_CHANGED_SINCE_BACKUP');
  const targets=new Map();
  for(let offset=0;offset<sourceRows.length;offset+=pageSize){
    const batch=sourceRows.slice(offset,offset+pageSize);
    for(const snapshot of await fetchDocuments(api,project,batch.map(row=>row.path)))
      if(snapshot.found) targets.set(snapshot.found.name.split('/documents/')[1],snapshot.found);
  }
  const verification=migrationPlan(sourceRows,targets,{includeParents:false});
  if(verification.some((item)=>item.status!=='unchanged'))throw new Error('CANONICAL_COPY_NOT_VERIFIED');
  if(!apply)return sourceRows.map((row)=>row.sourceName.split('/documents/')[1]);
  const groups=unionFind(sourceRows);
  const deleted=[];
  for(const group of groups){
    if(group.length>maxAtomicComponent)throw new Error('MIGRATION_COMPONENT_TOO_LARGE');
    const associated=locations.filter(({row})=>group.includes(row));
    const transaction=await beginTransaction(api,project);
    try{
      const paths=associated.flatMap(({document,row})=>[document.name.split('/documents/')[1],row.path]);
      const snapshots=await fetchDocuments(api,project,paths,transaction);
      const byName=new Map(snapshots.flatMap((entry)=>entry.found?[[entry.found.name,entry.found]]:[]));
      const writes=[];
      for(const {document,row} of associated){
        const sourcePath=document.name.split('/documents/')[1];
        const live=byName.get(targetName(project,sourcePath));
        const target=byName.get(targetName(project,row.path));
        if(!live || live.updateTime!==document.updateTime || !target || !fieldsEqual(target.fields,row.fields))
          throw new Error('MIGRATION_SOURCE_OR_TARGET_CHANGED');
        writes.push({delete:live.name,currentDocument:{updateTime:live.updateTime}});
      }
      await endTransaction(api,project,transaction,writes);
      deleted.push(...associated.map(({key})=>key));
    }catch(error){await safeRollback(api,project,transaction);throw error;}
  }
  return deleted;
}

async function run() {
  const options = { apply: false };
  const flags = new Map([['project','project'],['backup','backup'],['report','report'],['firebase-tools-dir','toolsDir']]);
  const args = process.argv.slice(2);
  for (let i=0;i<args.length;i++) {
    const key=args[i].replace(/^--/,'');
    if (key==='apply') options.apply=true;
    else if (key==='dry-run') options.apply=false;
    else if (key==='verify') options.verify=true;
    else if (key==='cleanup-legacy') options.cleanup=true;
    else if (key==='cutover-verified') options.cutoverVerified=true;
    else if (flags.has(key) && args[i+1] && !args[i+1].startsWith('--')) options[flags.get(key)]=args[++i];
    else throw new Error('INVALID_ARGUMENTS');
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project ?? '') ||
      !options.backup || !options.toolsDir)
    throw new Error('Usage: node db/scripts/migrate-schema.mjs --project os20th --firebase-tools-dir FIREBASE_TOOLS --backup PRIVATE.json [--dry-run|--apply|--verify] [--report PRIVATE.json]');
  const backupPath=await privateOutput(resolve(options.backup));
  const reportPath=await privateOutput(resolve(options.report ?? `${backupPath}.migration-report.json`));
  if (reportPath===backupPath) throw new Error('REPORT_CANNOT_OVERWRITE_BACKUP');
  const require=createRequire(resolve(options.toolsDir,'__migration__.cjs'));
  const auth=require('firebase-tools/lib/auth');
  const firebase=require('firebase-tools/lib/requireAuth');
  const {Client}=require('firebase-tools/lib/apiv2');
  const cliOptions={project:options.project,nonInteractive:true};
  const account=auth.getGlobalDefaultAccount();
  if (!account) throw new Error('FIREBASE_CLI_LOGIN_REQUIRED');
  auth.setActiveAccount(cliOptions,account);
  await firebase.requireAuth(cliOptions);
  const api=new Client({auth:true,apiVersion:'v1',urlPrefix:'https://firestore.googleapis.com'});
  const collectionIds=await require('firebase-tools/lib/gcp/firestore').listCollectionIds(options.project);
  const docs=await readAllDocuments(api,options.project,collectionIds);
  let backup;
  if(options.cleanup){
    if(!options.cutoverVerified)throw new Error('CUTOVER_CONFIRMATION_REQUIRED');
    if((await stat(backupPath)).size>100*1024*1024)throw new Error('BACKUP_TOO_LARGE');
    backup=JSON.parse((await readFile(backupPath,'utf8')).replace(/^\uFEFF/,''));
    const plan=await cleanupLegacy(api,options.project,docs,backup,{apply:options.apply});
    await writePrivateFile(reportPath,{project:options.project,mode:options.apply?'cleanup-legacy':'cleanup-dry-run',documents:plan.length,plan,completedAt:new Date().toISOString()},{overwrite:true});
    console.log(JSON.stringify({project:options.project,mode:options.apply?'cleanup-legacy':'cleanup-dry-run',sourceDocuments:plan.length,deleted:options.apply}));
    return;
  }
  backup=backupFromDocuments(options.project,docs);
  const backupWritten=options.verify?false:await writeOrReuseBackup(backupPath,backup);
  const rows=prepareRows(docs);
  const result=await migrateDocuments(api,options.project,rows,{apply:options.apply && !options.verify});
  if(options.verify&&result.plan.some((item)=>!['unchanged','preserved'].includes(item.status)))throw Object.assign(new Error('MIGRATION_INCOMPLETE'),{plan:result.plan});
  const report={project:options.project,mode:options.verify?'verify':options.apply?'apply':'dry-run',sourceDocumentCount:docs.length,targetDocumentCount:rows.length,collections:collectionIds,counts:Object.fromEntries([...new Set(result.plan.map(x=>x.status))].map(status=>[status,result.plan.filter(x=>x.status===status).length])),...result,completedAt:new Date().toISOString()};
  await writePrivateFile(reportPath,report,{overwrite:true});
  console.log(JSON.stringify({project:options.project,mode:report.mode,sourceDocuments:docs.length,targets:rows.length,counts:report.counts,backupWritten,applied:result.applied}));
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))
  run().catch((error)=>{
    if (error.plan) console.error(JSON.stringify({error:error.message,conflicts:error.plan.filter(row=>row.status==='conflict')}));
    else console.error(/^[A-Z0-9_ :-]+$/.test(error.message??'')?error.message:'SCHEMA_MIGRATION_FAILED');
    process.exitCode=1;
  });
