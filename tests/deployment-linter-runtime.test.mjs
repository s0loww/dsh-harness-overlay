import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {LINTER_LOCK,JAVA_LINTER_ARGS,renderBslWrapper,linterChildEnvironment,verifyLinterRuntime,probeLinterRuntime} from '../src/deployment-bundle/linter/runtime.mjs'
import {LINTER_FILE_LOCK} from '../src/deployment-bundle/linter/lock-files.mjs'
test('supplier pins bind exact stable Java and BSL runtime plus complete redistributable sources/notices',()=>{
 assert.equal(LINTER_LOCK.bsl.version,'1.0.7');assert.equal(LINTER_LOCK.java.version,'21.0.13+9')
 assert.equal(LINTER_FILE_LOCK['bsl-language-server.jar'].sha256,LINTER_LOCK.bsl.jarSha256)
 assert.ok(LINTER_FILE_LOCK['java/bin/java.exe']);assert.ok(LINTER_FILE_LOCK['java/legal/java.base/ASSEMBLY_EXCEPTION']);assert.ok(LINTER_FILE_LOCK['notices/BSL-LGPL-3.0.md']);assert.ok(LINTER_FILE_LOCK['notices/bsl-language-server-source.zip']);assert.ok(LINTER_FILE_LOCK['notices/OpenJDK21U-sources_21.0.13_9.tar.gz'])
 assert.equal(LINTER_FILE_LOCK['notices/OpenJDK21U-sources_21.0.13_9.tar.gz'].sha256,LINTER_LOCK.java.sourceArchiveSha256)
})
test('owned Java subprocess excludes inherited Java option injection without changing the parent environment',()=>{
 const parent={PATH:'recipient-path',JAVA_HOME:'recipient-java',JAVA_TOOL_OPTIONS:'private-proxy-options',_JAVA_OPTIONS:'-Xmx8g',JDK_JAVA_OPTIONS:'unsafe-implicit-options',Keep:'value'},child=linterChildEnvironment(parent)
 assert.deepEqual(child,{PATH:'recipient-path',JAVA_HOME:'recipient-java',Keep:'value'});assert.equal(parent._JAVA_OPTIONS,'-Xmx8g')
 assert.ok(JAVA_LINTER_ARGS.includes('-Xmx1g'));assert.ok(JAVA_LINTER_ARGS.includes('-Dserver.address=127.0.0.1'))
 const wrapper=renderBslWrapper();assert.match(wrapper,/setlocal DisableDelayedExpansion\r\nchcp 65001/);assert.match(wrapper,/"%~dp0\.\.\\java\\bin\\java.exe"/);assert.match(wrapper,/-jar "%~dp0bsl-language-server.jar" %\*/)
 assert.doesNotMatch(wrapper,/setx|reg add|npm|powershell|Invoke-WebRequest/iu)
})
test('edited metadata cannot authorize a different JAR or executable before any Java launch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bsl-runtime-pin-'));const files=structuredClone(LINTER_FILE_LOCK);files['bsl-language-server.jar'].sha256='0'.repeat(64)
 await writeFile(join(root,'metadata.json'),JSON.stringify({schemaVersion:1,kind:'airules-local-bsl-runtime',lock:LINTER_LOCK,files}))
 await assert.rejects(verifyLinterRuntime({assetsRoot:root}),/LINTER_RUNTIME_INVENTORY_INVALID/)
})
test('runtime probe refuses an existing project directory before creating config/source/report files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bsl-probe-owned-'));await writeFile(join(root,'project.txt'),'recipient data')
 await assert.rejects(probeLinterRuntime({assetsRoot:root,fixtureRoot:root}),/LINTER_PROBE_FRESH_ROOT_REQUIRED/)
 assert.equal(await readFile(join(root,'project.txt'),'utf8'),'recipient data')
 await assert.rejects(readFile(join(root,'.bsl-language-server.json')),e=>e.code==='ENOENT')
})
