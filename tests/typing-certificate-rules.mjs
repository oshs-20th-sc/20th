import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {encodeData,documentPath} from '../db/schema.js';
import {typingCertificate,typingCertificateKey} from '../db/typing-certificate.js';
const require=createRequire(import.meta.url);
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
const firebase=require('firebase/compat/app');require('firebase/compat/firestore');
const env=await initializeTestEnvironment({projectId:'demo-oshs-certificate-rules',firestore:{host:'127.0.0.1',port:8088,rules:await readFile(new URL('../db/firestore.rules',import.meta.url),'utf8')}});
const pub=env.unauthenticatedContext().firestore(),admin=env.authenticatedContext('operator').firestore();
const now=()=>firebase.firestore.FieldValue.serverTimestamp();
const challenge={challengeId:'certificate-test',title:'기록증 문구',text:'가나',referenceKeystrokes:4,practice:false,errorPenalty:3,enabled:true,deleted:false};
const ref=(db,kind,id)=>db.doc(documentPath(kind,id));
const record=(id,number='20101',name='오별이')=>({id,entry_mode:'record',owner_uid:null,participantId:number,displayName:name,challengeId:challenge.challengeId,elapsedMs:12000,speed:20,errors:2,score:14,completedAt:'2026-11-16T00:00:00.000Z',practice:false,prizeReceived:false,verificationStatus:'pending',reviewed_at:null,received_at:now()});
let n=0;const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
async function submit(value,{certificate=true,patch={},key}={}){const b=pub.batch();b.set(ref(pub,'typingResults',value.id),encodeData('typingResults',value));b.set(ref(pub,'typingReceipts',value.id),encodeData('typingReceipts',{id:value.id,owner_uid:null,entry_mode:'record',kind:'typing',payload_hash:'a'.repeat(64),created_at:now()}));b.set(ref(pub,'typingEntries',value.participantId),encodeData('typingEntries',{kind:'typingEntry',student_number:value.participantId,result_id:value.id,created_at:now()}));if(certificate)b.set(ref(pub,'typingCertificates',key??await typingCertificateKey(value.participantId,value.displayName)),{...encodeData('typingCertificates',typingCertificate(value,challenge)),...patch});return b.commit();}
async function seed(entries){await env.withSecurityRulesDisabled(async c=>{for(const [kind,id,data]of entries)await ref(c.firestore(),kind,id).set(encodeData(kind,data));});}
try{
 await seed([['admins','operator',{enabled:true,email:'operator@example.test',created_at:new Date()}],['settings','event',{phase:'A',activeChallengeId:challenge.challengeId,submissionsEnabled:true,updated_at:new Date()}],['challenges',challenge.challengeId,{title:challenge.title,text:challenge.text,referenceKeystrokes:4,practice:false,errorPenalty:3,enabled:true,deleted:false}]]);
 const value=record(uuid()),key=await typingCertificateKey(value.participantId,value.displayName);
 await assertSucceeds(submit(value));
 assert.equal((await assertSucceeds(ref(pub,'typingCertificates',key).get())).data()['최종점수'],14);
 assert.equal((await assertSucceeds(ref(pub,'typingCertificates',await typingCertificateKey('20101','다른이름')).get())).exists,false);
 await assertFails(pub.collection('타자대회/기본/기록증').get());
 await assertFails(ref(pub,'typingResults',value.id).get());await assertFails(ref(pub,'typingEntries','20101').get());
 await assertFails(ref(pub,'typingCertificates',key).update({'최종점수':99}));
 await assertFails(ref(pub,'typingCertificates',key).delete());
 await assertFails(pub.doc('타자대회/2026-11-22/기록증/'+key).get());
 await assertFails(ref(pub,'typingCertificates','20101').get());
 const bad=record(uuid(),'20102');await assertFails(submit(bad,{patch:{'최종점수':999}}));
 await assertFails(submit(record(uuid(),'20102'),{patch:{'이전계정UID':'private'}}));
 await assertFails(submit(record(uuid(),'20102'),{key:'b'.repeat(64)}));
 const lone=typingCertificate(record(uuid(),'20104'),challenge);await assertFails(ref(pub,'typingCertificates',await typingCertificateKey('20104','오별이')).set(encodeData('typingCertificates',lone)));
 await assertFails(ref(admin,'typingCertificates',key).delete());
 const partial=admin.batch();partial.delete(ref(admin,'typingResults',value.id));partial.delete(ref(admin,'typingReceipts',value.id));partial.delete(ref(admin,'typingEntries','20101'));await assertFails(partial.commit());
 const duplicate=record(uuid());await seed([['typingResults',duplicate.id,duplicate]]);await assertSucceeds(ref(admin,'typingResults',duplicate.id).delete());assert.equal((await ref(pub,'typingCertificates',key).get()).exists,true);
 const full=admin.batch();full.delete(ref(admin,'typingResults',value.id));full.delete(ref(admin,'typingReceipts',value.id));full.delete(ref(admin,'typingEntries','20101'));full.delete(ref(admin,'typingCertificates',key));await assertSucceeds(full.commit());
 assert.equal((await ref(pub,'typingCertificates',key).get()).exists,false);
 await assertSucceeds(submit(record(uuid())));
 const old=record(uuid(),'20103');await assertSucceeds(submit(old,{certificate:false}));await assertSucceeds(ref(admin,'typingCertificates',await typingCertificateKey('20103','오별이')).set(encodeData('typingCertificates',typingCertificate(old,challenge))));
 console.log('typing certificate rules: exact lookup, private lists/results, immutable source-bound projection, atomic deletion/reentry, old-client compatibility and admin backfill passed');
}finally{await env.cleanup();}
