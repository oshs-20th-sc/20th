import assert from 'node:assert/strict';
import {
  applyComponent,
  backupFromDocuments,
  cleanupLegacy,
  decodeValue,
  encodeValue,
  fieldsEqual,
  migrateDocuments,
  migrationPlan,
  prepareRows,
} from '../db/scripts/migrate-schema.mjs';
import { restoreBackup, validateBackup } from '../db/scripts/restore-backup.mjs';

const project='demo-migration';
const base=`projects/${project}/databases/(default)/documents`;
const challengeId='aegukga-verse1-practice-v1-floor0';
const resultId='00000000-0000-4000-8000-000000000001';
const claimId='official-20261123-20101';
const letterId='00000000-0000-4000-8000-000000000002';

const timestamp='2026-11-16T02:03:04.123456789Z';
const ts={timestampValue:timestamp};
assert.deepEqual(decodeValue(ts),{__firestoreTimestamp:true,seconds:1794794584,nanoseconds:123456789});
assert.equal(encodeValue(decodeValue(ts)).timestampValue,timestamp);
assert.equal(decodeValue({doubleValue:23.5}),23.5);
assert.equal(decodeValue({arrayValue:{values:[{integerValue:'1'},{nullValue:null}]}}).length,2);
assert.throws(()=>decodeValue({integerValue:'9007199254740993'}),/INTEGER_OUT_OF_RANGE/);

function doc(collection,id,fields,updateTime='2026-11-16T00:00:00Z'){
  return {name:`${base}/${collection}/${id}`,fields,updateTime};
}
const record=doc('typingResults',resultId,{
  id:{stringValue:resultId},entry_mode:{stringValue:'record'},owner_uid:{nullValue:null},
  participantId:{stringValue:'20101'},displayName:{stringValue:'김학생'},
  challengeId:{stringValue:challengeId},elapsedMs:{doubleValue:12345},speed:{integerValue:'12'},
  errors:{integerValue:'2'},score:{integerValue:'6'},completedAt:{stringValue:'2026-11-16T00:00:00Z'},
  received_at:ts,reviewed_at:{nullValue:null},prizeReceived:{booleanValue:false},
  practice:{booleanValue:false},verificationStatus:{stringValue:'pending'},
});
const receipt=doc('receipts',resultId,{id:{stringValue:resultId},owner_uid:{nullValue:null},entry_mode:{stringValue:'record'},kind:{stringValue:'typing'},payload_hash:{stringValue:'a'.repeat(64)},created_at:ts});
const claim=doc('receipts',claimId,{kind:{stringValue:'typingEntry'},student_number:{stringValue:'20101'},result_id:{stringValue:resultId},created_at:ts});
const letter=doc('letters',letterId,{id:{stringValue:letterId},entry_mode:{stringValue:'record'},owner_uid:{nullValue:null},student_number:{stringValue:'20102'},student_name:{stringValue:'글학생'},nickname:{nullValue:null},content:{stringValue:'안녕하세요'},published_content:{nullValue:null},consent_to_publish:{integerValue:'1'},status:{stringValue:'pending'},publish_order:{nullValue:null},submission_key:{stringValue:letterId},created_at:ts,reviewed_at:{nullValue:null}});
const logId=`${letterId}-restore`;
const log=doc('letterLogs',logId,{letter_id:{stringValue:letterId},operator_uid:{stringValue:'uid'},action:{stringValue:'restore'},before:{mapValue:{fields:{id:{stringValue:letterId},content:{stringValue:'복원'},student_number:{stringValue:'20102'}}}},after:{nullValue:null},created_at:ts});
const admin=doc('admins','admin-test-1',{enabled:{booleanValue:true},email:{stringValue:'admin@example.test'},created_at:ts});
const sources=[record,receipt,claim,letter,log,admin];
const rows=prepareRows(sources);
const byPath=new Map(rows.map((row)=>[row.path,row]));
assert.equal(byPath.get('타자대회/2026-11-23/기록/'+resultId).fields['소요시간밀리초'].doubleValue,12345,
  'integral double keeps its original Firestore value type');
assert.equal(byPath.get('타자대회/2026-11-23/기록/'+resultId).fields['학번'].stringValue,'20101');
assert.equal(byPath.get('타자대회/2026-11-23/참여제한/20101').fields['기록ID'].stringValue,resultId);
assert.equal(byPath.get('글쓰기/기본/검수이력/'+logId).fields['변경전'].mapValue.fields['학번'].stringValue,'20102');
assert.equal(byPath.get('타자대회/2026-11-23/접수확인/'+resultId).fields['내용해시'].stringValue,'a'.repeat(64));
assert.throws(()=>prepareRows([doc('letters',letterId,{bogus:{stringValue:'unknown'}})]));

const backup=backupFromDocuments(project,sources);
assert.equal(backup.schemaVersion,4);
assert.equal(backup.collections.admins[0].id,'admin-test-1');
assert.equal(backup.migrationSnapshot.updateTimes[`typingResults/${resultId}`],record.updateTime);
assert.equal(backup.migrationSnapshot.rawDocuments[`typingResults/${resultId}`].fields.elapsedMs.doubleValue,12345,
  'private migration snapshot retains Firestore REST typed values');
assert.equal(validateBackup(backup).length,sources.length);
const v5={schemaVersion:5,backend:'firebase',projectId:project,includesAuthentication:false,collections:{
  typingEntries:[{id:claimId,data:{'접수종류':'typingEntry','학번':'20101','기록ID':resultId,'생성시각':{__firestoreTimestamp:true,seconds:1794794584,nanoseconds:123456789}}}],
  settings:[{id:'event',data:{'운영단계':'A','수정시각':{__firestoreTimestamp:true,seconds:1794794584,nanoseconds:123456789}}}],
}};
assert.equal(validateBackup(v5).length,2);
const aliasedBackup=structuredClone(v5);
aliasedBackup.collections.settings.push({...structuredClone(aliasedBackup.collections.settings[0]),id:'행사'});
await assert.rejects(()=>restoreBackup({projectId:project,doc(){throw Error('must reject aliases before any read or write')}},aliasedBackup,{apply:true}),/DUPLICATE_RESTORE_DESTINATION/);
const restoredPaths=[];
const restoreResult=await restoreBackup({projectId:project,doc(path){restoredPaths.push(path);return{get:async()=>({exists:false})};}},v5,{apply:false});
assert(restoredPaths.includes('타자대회/2026-11-23/참여제한/20101'));
assert(restoredPaths.includes('운영설정/행사'));
assert(restoredPaths.includes('타자대회/2026-11-23'));
assert.equal(restoreResult.results.length,3,'restore plan includes a missing parent document');
const restoredDocs=new Map();
class MockTimestamp { constructor(seconds,nanoseconds){this.seconds=seconds;this.nanoseconds=nanoseconds;} }
await restoreBackup({projectId:project,doc(path){return{path,get:async()=>({exists:restoredDocs.has(path),data:()=>restoredDocs.get(path)})};},
  async runTransaction(fn){return fn({async get(ref){return{exists:restoredDocs.has(ref.path),data:()=>restoredDocs.get(ref.path)};},
    create(ref,data){restoredDocs.set(ref.path,data);}});}},v5,{apply:true,Timestamp:MockTimestamp});
assert(restoredDocs.has('타자대회/2026-11-23'),'restore creates parent metadata before use');
assert(restoredDocs.has('타자대회/2026-11-23/참여제한/20101'));
const operatorParent={행사명:'관리자 수정값'};
const restorePreserved=new Map([['타자대회/2026-11-23',operatorParent]]);
await restoreBackup({projectId:project,doc(path){return{path,get:async()=>({exists:restorePreserved.has(path),data:()=>restorePreserved.get(path)})};},
  async runTransaction(fn){return fn({async get(ref){return{exists:restorePreserved.has(ref.path),data:()=>restorePreserved.get(ref.path)};},
    create(ref,data){restorePreserved.set(ref.path,data);}});}},v5,{apply:true,Timestamp:MockTimestamp});
assert.deepEqual(restorePreserved.get('타자대회/2026-11-23'),operatorParent,
  'restore preserves existing operator-owned parent metadata');
const statuses=migrationPlan(rows,new Map([[rows[0].path,{fields:rows[0].fields}]]));
assert.equal(statuses.find(row=>row.path===rows[0].path).status,'unchanged');
assert.equal(statuses.filter(row=>row.status==='create').length,rows.length+1,
  'plan includes the remaining data rows and both missing parents');
assert(fieldsEqual({a:{x:1},b:2},{b:2,a:{x:1}}));

function mockFirestore(initialDocs=[]){
  const docs=new Map(initialDocs.map((item)=>[item.name,item]));
  const calls=[];let sequence=0;
  return {docs,calls,async post(url,body){
    calls.push({url,body});
    if(url.endsWith(':beginTransaction'))return{body:{transaction:`tx-${++sequence}`}};
    if(url.endsWith(':rollback'))return{body:{}};
    if(url.endsWith(':batchGet'))return{body:body.documents.map(name=>docs.has(name)?{found:docs.get(name)}:{missing:name})};
    if(url.endsWith(':commit')){
      for(const write of body.writes??[]){
        if(write.delete){const prior=docs.get(write.delete);assert(prior);assert.equal(prior.updateTime,write.currentDocument.updateTime);docs.delete(write.delete);}
        else if(write.update){assert(!docs.has(write.update.name),'exists:false must protect existing documents');docs.set(write.update.name,{...write.update,updateTime:`2026-11-16T00:00:${String(sequence++).padStart(2,'0')}Z`});}
      }
      return{body:{writeResults:[]}};
    }
    throw new Error(`Unexpected request ${url}`);
  }};
}

const simulated=mockFirestore(sources);
const initial=await migrateDocuments(simulated,project,rows,{apply:false});
assert.equal(initial.applied,false);
assert.equal(initial.plan.filter(item=>item.status==='create').length,rows.length+2);
const applied=await migrateDocuments(simulated,project,rows,{apply:true});
assert.equal(applied.applied,true);
assert.equal(applied.plan.filter(item=>item.status==='create').length,rows.length+2);
assert.equal(applied.parentsCreated,2);
assert(simulated.docs.has(`${base}/타자대회/2026-11-23`));
assert(simulated.docs.has(`${base}/글쓰기/기본`));
assert.equal([...simulated.docs.keys()].filter(name=>name.includes('/타자대회/2026-11-23/')).length,3);
assert.equal([...simulated.docs.keys()].filter(name=>name.includes('/글쓰기/기본/')).length,2);
assert(sources.every(source=>simulated.docs.has(source.name)),'migration keeps every source document for rollback');
const repeated=await migrateDocuments(simulated,project,rows,{apply:true});
assert(repeated.plan.filter(item=>item.kind!=='parent').every(item=>item.status==='unchanged'));
assert.equal(repeated.plan.filter(item=>item.kind==='parent').length,2);
assert(repeated.plan.filter(item=>item.kind==='parent').every(item=>item.status==='unchanged'));

const operatorMetadata={fields:{행사명:{stringValue:'운영자가 수정한 행사명'}}};
const preserveParent=mockFirestore([...sources,{name:`${base}/타자대회/2026-11-23`,...operatorMetadata,updateTime:'2026-11-16T01:00:00Z'}]);
const preserved=await migrateDocuments(preserveParent,project,rows,{apply:false});
assert.equal(preserved.plan.find(item=>item.path==='타자대회/2026-11-23').status,'preserved');
assert.equal(preserved.plan.find(item=>item.path==='글쓰기/기본').status,'create');
await migrateDocuments(preserveParent,project,rows,{apply:true});
assert.deepEqual(preserveParent.docs.get(`${base}/타자대회/2026-11-23`).fields,operatorMetadata.fields,
  'operator-owned parent metadata is never overwritten');
assert(preserveParent.docs.has(`${base}/글쓰기/기본`),'missing parent metadata is created');

const conflicts=mockFirestore([...sources,{name:`${base}/${rows[0].path}`,fields:{wrong:{stringValue:'value'}}}]);
await assert.rejects(()=>migrateDocuments(conflicts,project,rows,{apply:true}),/DESTINATION_CONFLICT/);
assert.equal(conflicts.calls.filter(call=>call.url.endsWith(':commit')).length,0);

const changedSource=mockFirestore(sources.map((item)=>item===record?{...item,updateTime:'2026-11-17T00:00:00Z'}:item));
await assert.rejects(()=>applyComponent(changedSource,project,rows.slice(0,1)),/SOURCE_CHANGED_DURING_MIGRATION/);
assert.equal(changedSource.docs.has(`${base}/${rows[0].path}`),false);

const migrated=mockFirestore([...sources,...rows.map((row)=>({name:`${base}/${row.path}`,fields:row.fields,updateTime:'2026-11-16T01:00:00Z'}))]);
const backupWithTimes={...backup,migrationSnapshot:{
  updateTimes:Object.fromEntries(sources.map(item=>[`${item.name.split('/').at(-2)}/${item.name.split('/').at(-1)}`,item.updateTime])),
  rawDocuments:Object.fromEntries(sources.map(item=>[`${item.name.split('/').at(-2)}/${item.name.split('/').at(-1)}`,{updateTime:item.updateTime,fields:item.fields}]))
}};
const dryCleanup=await cleanupLegacy(migrated,project,sources,backupWithTimes,{apply:false});
assert.equal(dryCleanup.length,sources.length);
assert(sources.every((source)=>migrated.docs.has(source.name)));
const tamperedBackup=structuredClone(backupWithTimes);
tamperedBackup.migrationSnapshot.rawDocuments[`letters/${letterId}`].fields.content.stringValue='изменено';
await assert.rejects(()=>cleanupLegacy(migrated,project,sources,tamperedBackup,{apply:true}),/LEGACY_SOURCE_CHANGED_SINCE_BACKUP/);
assert(sources.every((source)=>migrated.docs.has(source.name)),'edited backup cannot authorize cleanup');
const addedSource=[...sources,doc('letters','00000000-0000-4000-8000-000000000099',letter.fields)];
await assert.rejects(()=>cleanupLegacy(migrated,project,addedSource,backupWithTimes,{apply:true}),/LEGACY_SOURCE_CHANGED_SINCE_BACKUP|LEGACY_SOURCE_SET_CHANGED_SINCE_BACKUP/);
assert(sources.every((source)=>migrated.docs.has(source.name)),'unbacked source addition stops cleanup');
const removed=await cleanupLegacy(migrated,project,sources,backupWithTimes,{apply:true});
assert.equal(removed.length,sources.length);
assert(sources.every((source)=>!migrated.docs.has(source.name)));
assert(rows.every((row)=>migrated.docs.has(`${base}/${row.path}`)));

const changedDocs=sources.map((item)=>item===letter?{...item,updateTime:'2026-11-17T00:00:00Z'}:item);
const sourceChanged=mockFirestore(changedDocs);
for(const row of rows)sourceChanged.docs.set(`${base}/${row.path}`,{name:`${base}/${row.path}`,fields:row.fields,updateTime:'2026-11-16T01:00:00Z'});
await assert.rejects(()=>cleanupLegacy(sourceChanged,project,changedDocs,backupWithTimes,{apply:true}),/LEGACY_SOURCE_CHANGED_SINCE_BACKUP/);
assert(sourceChanged.docs.has(letter.name));

const targetChanged=mockFirestore([...sources,...rows.map((row)=>({name:`${base}/${row.path}`,fields:row.path===rows[0].path?{changed:{booleanValue:true}}:row.fields,updateTime:'2026-11-16T01:00:00Z'}))]);
await assert.rejects(()=>cleanupLegacy(targetChanged,project,sources,backupWithTimes,{apply:true}),/CANONICAL_COPY_NOT_VERIFIED/);
assert(sources.every((source)=>targetChanged.docs.has(source.name)));

console.log('schema migration safety checks passed');
