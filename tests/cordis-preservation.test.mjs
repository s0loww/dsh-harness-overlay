import test from 'node:test'
import assert from 'node:assert/strict'
import {reverseCordisChanges} from '../installer/official-live/cordis-preservation.mjs'
const conflict={code:'LIVE_CORDIS_PRESERVATION_CONFLICT'}
const native='\n# native settings retained byte-for-byte\n- id: onboarding\n  config: { complete: true }\n- id: office\n  config:\n    mode: "read only"\n- id: native-provider\n  config: { enabled: false }\n- id: native-shortcuts\n  config: { enabled: true }\n'
test('fresh reverse removes only installed rows and preserves native append plus formatting',()=>{
 const before='# baseline\n[]\n',installed='# baseline\n- id: managed\n  config:\n    enabled: true\n- insert:\n  - id: ui-addon\n    config: {}\n',current='# baseline\n- id: managed\n  config: { enabled: true }\n- insert:\n  - id: ui-addon\n    config: {}\n'+native
 const result=reverseCordisChanges({before,installed,current});assert.equal(result.preservedUnmanaged,true);assert.equal(result.text.toString(),'# baseline\n'+native)
})
test('installed whole-file match restores exact baseline BOM and CRLF bytes',()=>{
 const before=Buffer.from('\uFEFF# baseline\r\n[]\r\n'),installed=Buffer.from('- id: managed\n  config: {}\n'),result=reverseCordisChanges({before,installed,current:installed});assert.deepEqual(result.text,before);assert.equal(result.preservedUnmanaged,false)
})
test('an unchanged update preserves all current native edits',()=>{
 const before='- id: managed\n  config: { enabled: true }\n',current='- id: managed\n  config: { enabled: false }\n'+native
 const result=reverseCordisChanges({before,installed:before,current});assert.equal(result.text.toString(),current);assert.equal(result.preservedUnmanaged,true)
})
test('owned changed fields are restored while unrelated rows remain exact',()=>{
 const before='- id: managed\n  config: { version: 1 }\n',installed='- id: managed\n  config: { version: 2 }\n'
 assert.equal(reverseCordisChanges({before,installed,current:installed+native}).text.toString(),before+native)
 for(const current of [installed.replace('version: 2','version: 3')+native,native])assert.throws(()=>reverseCordisChanges({before,installed,current}),conflict)
})
test('an installer-deleted row returns before native user additions',()=>{
 const before='- id: kept\n  config: {}\n- id: removed\n  config: {}\n',installed='- id: kept\n  config: {}\n'
 assert.equal(reverseCordisChanges({before,installed,current:installed+native}).text.toString(),before+native)
 assert.throws(()=>reverseCordisChanges({before,installed,current:installed+'- id: removed\n  config: { user: true }\n'}),conflict)
})
test('duplicate root identity, duplicate insert id, aliases, invalid tags and owned edits refuse',()=>{
 const before='[]\n',installed='- id: managed\n  config: {}\n'
 const cases=[installed+installed,'- insert:\n  - id: same\n  - id: same\n','- id: managed\n  config: &a {}\n- id: alias\n  config: *a\n','- id: managed\n  config: !unknown value\n','- id: managed\n  config: { modified: true }\n',installed+'- id: nonfinite\n  config: .inf\n']
 for(const current of cases)assert.throws(()=>reverseCordisChanges({before,installed,current}),conflict)
})
test('JS tags remain opaque data and native BOM survives partial preservation',()=>{
 const before=Buffer.from('\uFEFF# base\n[]\n'),installed=Buffer.from('\uFEFF# base\n- id: managed\n  config: !!js "throw new Error(\\\"never execute\\\")"\n'),current=Buffer.concat([installed,Buffer.from(native)])
 const result=reverseCordisChanges({before,installed,current});assert.ok(result.text.subarray(0,3).equals(Buffer.from([239,187,191])));assert.ok(result.text.toString().endsWith(native))
})
test('changed rows without identity and ambiguous or reordered managed rows refuse',()=>{
 assert.throws(()=>reverseCordisChanges({before:'[]\n',installed:'- config: {}\n',current:'- config: {}\n'+native}),conflict)
 const installed='- id: a\n  config: {}\n- id: b\n  config: {}\n';assert.throws(()=>reverseCordisChanges({before:'[]\n',installed,current:'- id: b\n  config: {}\n- id: a\n  config: {}\n'+native}),conflict)
})
test('a baseline row without final newline remains separated from following native rows',()=>{
 const before='- id: managed\n  config: { version: 1 }',installed='- id: managed\n  config: { version: 2 }\n',result=reverseCordisChanges({before,installed,current:installed+native});assert.equal(result.text.toString(),before+'\n'+native)
})
test('BOM immediately followed by a root dash parses through an offset without dropping bytes',()=>{
 const before=Buffer.from('\uFEFF[]\r\n'),installed=Buffer.from('\uFEFF- id: owned\r\n  config: {}\r\n'),current=Buffer.concat([installed,Buffer.from(native)]),result=reverseCordisChanges({before,installed,current});assert.ok(result.text.subarray(0,3).equals(Buffer.from([239,187,191])));assert.ok(result.text.toString().endsWith(native))
})
test('root id or nested insert cannot shadow an installer-owned inserted identity',()=>{
 const before='[]\n',installed='- insert:\n  - id: owned\n    config: {}\n'
 for(const shadow of ['- id: owned\n  config: {}\n','- id: foreign\n  insert:\n  - id: owned\n    config: {}\n'])assert.throws(()=>reverseCordisChanges({before,installed,current:installed+shadow}),conflict)
})
test('a nested shadow also prevents restoring an installer-deleted baseline identity',()=>{
 const before='- id: kept\n  config: {}\n- id: removed\n  config: {}\n',installed='- id: kept\n  config: {}\n',current=installed+'- id: foreign\n  insert:\n  - id: removed\n    config: {}\n';assert.throws(()=>reverseCordisChanges({before,installed,current}),conflict)
})
