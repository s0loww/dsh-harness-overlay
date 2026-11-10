import test from 'node:test'
import assert from 'node:assert/strict'
import { projectIdentity, sourcePath, endpoint, edgeId, provenance, emptyGraph, validateGraph, filterEdges } from '../src/evidence-links/lib/core.js'
test('stable project, endpoint and directed relation identities preserve original source semantics',()=>{
  const project=projectIdentity('D:/Projects/Example')
  assert.equal(project,projectIdentity('d:\\projects\\example\\'))
  assert.notEqual(project,projectIdentity('D:/Projects/Other'))
  const a=endpoint({kind:'file',path:'src/Module.bsl',range:{startLine:2,endLine:3}},project),b=endpoint({kind:'note',backend:'memoria',namespace:'project',recordId:'note-13'},project)
  const{nodeId,...raw}=a;assert.equal(a.nodeId,endpoint({...raw,label:'Different display title'},project).nodeId)
  assert.equal(edgeId(project,'implements',a.nodeId,b.nodeId),edgeId(project,'implements',a.nodeId,b.nodeId))
  assert.notEqual(edgeId(project,'related',a.nodeId,b.nodeId),edgeId(project,'implements',a.nodeId,b.nodeId))
})
test('metadata rejects traversal, protected source files, copied bodies, credentials, foreign store and malformed timestamps',()=>{
  const project=projectIdentity('/workspace'),now='2026-11-11T10:00:00.000Z'
  for(const path of ['../outside','/root','.env','.env.local','.git/config','nested/.ssh/id_rsa','src/../file','src\\file','credentials.json','C:/other'])assert.throws(()=>sourcePath(path),/LINKS_/)
  for(const raw of [{kind:'document',id:'doc',body:'copy'},{kind:'source',id:'https://host/path?token=abc'},{kind:'note',backend:'memoria',namespace:'p',recordId:'password=secret'},{kind:'file',path:'src/a',range:{startLine:3,endLine:2}}])assert.throws(()=>endpoint(raw,project),/LINKS_/)
  assert.throws(()=>provenance({ref:'a'},'actor','invalid'),/LINKS_/)
  assert.throws(()=>provenance({ref:'a',observedAt:'2027-11-11T10:00:00.000Z'},'actor',now),/LINKS_/)
  assert.throws(()=>validateGraph(emptyGraph(project),'project-foreign'),/LINKS_STORE_INVALID/)
  assert.throws(()=>filterEdges(emptyGraph(project),{limit:31}),/LINKS_QUERY_INVALID/)
})
