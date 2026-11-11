import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm, lstat, open } from 'node:fs/promises'
import { dirname, join, isAbsolute, resolve, relative } from 'node:path'
import { DEFAULT_PROCESSING, validateProcessing, processingFingerprint, discoverProcessingModels, localModelEndpoint } from './processing.js'

const fail = code => { throw new Error(code) }, digest = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const marker = '# airules-managed-cognee-processing-v1'
const OVERRIDE = marker + '\nservices:\n  cognee:\n    environment:\n      GRAPH_EXTRACTOR: ${GRAPH_EXTRACTOR}\n'
const textId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u.test(value)
export function validateProcessingBinding(value) {
  const allowed = ['schemaVersion', 'composeDir', 'composeFile', 'envFile', 'container', 'service', 'ownerSid']
  if (!value || Object.keys(value).some(key => !allowed.includes(key)) || value.schemaVersion !== 1 || !isAbsolute(value.composeDir ?? '') || value.composeFile !== 'compose.yaml' || value.envFile !== '.env' || value.service !== 'cognee' || !textId(value.container) || value.ownerSid !== undefined && !/^S-1-(?:\d+-){1,14}\d+$/u.test(value.ownerSid)) fail('PROCESSING_BINDING_INVALID')
  return { ...value, composeDir: resolve(value.composeDir) }
}
// Fixed read-only scripts. They do not import cognee or materialize model weights,
// expose credentials, read note bodies, generate embeddings or call a remote LLM.
export const PROCESSING_CACHE_SCRIPT = String.raw`import json,pathlib,os
models=[]
try:
 from fastembed import TextEmbedding
 root=pathlib.Path(os.environ.get('FASTEMBED_CACHE_PATH','/cognee-storage/models/fastembed'))
 for item in TextEmbedding.list_supported_models()[:300]:
  repo=(item.get('sources') or {}).get('hf',''); name=item.get('model'); file=item.get('model_file')
  if not repo or not name or not file: continue
  folder=root/('models--'+repo.replace('/','--'))/'snapshots'
  if folder.is_dir() and any((snap/file).is_file() and (snap/'tokenizer.json').is_file() for snap in list(folder.iterdir())[:30]):
   models.append({'id':name,'provider':'fastembed','kind':'embeddings','state':'installed','dimensions':item.get('dim') or item.get('embed_dim')})
except Exception: pass
root=pathlib.Path(os.environ.get('HF_HOME','/cognee-storage/models/huggingface'))/'hub'/'models--fastino--gliner2.5-base-v1'/'snapshots'
if root.is_dir() and any((snap/'config.json').is_file() and any(p.is_file() for p in list(snap.glob('*.safetensors'))+list(snap.glob('pytorch_model*.bin'))) for snap in list(root.iterdir())[:30]):
 models.append({'id':'fastino/gliner2.5-base-v1','provider':'gliner','kind':'extraction','state':'installed'})
print(json.dumps({'models':models[:100]}))`
export const PROCESSING_SERVER_SCRIPT = String.raw`import json,os,sqlite3,pathlib,urllib.request,urllib.parse,importlib.metadata
keys=['GRAPH_EXTRACTOR','EMBEDDING_PROVIDER','EMBEDDING_MODEL','EMBEDDING_DIMENSIONS','EMBEDDING_ENDPOINT','LLM_PROVIDER','LLM_MODEL','LLM_ENDPOINT','LLM_EXTRACTION_PROVIDER','LLM_EXTRACTION_MODEL','LLM_EXTRACTION_ENDPOINT']
env={k:os.environ.get(k,'')[:500] for k in keys}
for k,v in list(env.items()):
 if k.endswith('ENDPOINT') and v:
  u=urllib.parse.urlsplit(v)
  if u.username or u.password or u.query or u.fragment: env[k]='[unsupported-auth-url]'
skip=any(os.environ.get(k,'').lower() in ('true','1','yes') for k in ('COGNEE_SKIP_PREFLIGHT','COGNEE_SKIP_CONNECTION_TEST','MOCK_EMBEDDING'))
keyless=not skip and not os.environ.get('LLM_API_KEY','').strip() and os.environ.get('LLM_PROVIDER','openai').lower() not in ('bedrock','llama_cpp') and not (os.environ.get('LLM_PROVIDER','').lower()=='azure' and os.environ.get('LLM_AZURE_USE_MANAGED_IDENTITY','').lower() in ('true','1','yes'))
result={'version':importlib.metadata.version('cognee'),'environment':env,'healthy':False,'dataCount':None,'activeRuns':None,'databaseVerified':False,'keylessLocalDefaults':keyless,'modelEndpointsReachable':True,'modelCredentialsConfigured':True,'unsupportedOverrides':skip or os.environ.get('STRUCTURED_OUTPUT_FRAMEWORK','litellm_native') not in ('','litellm_native','instructor') or any(v for k,v in os.environ.items() if k.startswith(('LLM_SUMMARIZATION_','LLM_QUERY_'))),'remoteGliner':any(v for k,v in os.environ.items() if k.startswith('GLINER_REMOTE_') and not k.endswith('_MAX_RESPONSE_BYTES'))}
for prefix in ('LLM','EMBEDDING'):
 if 'openrouter.ai' in os.environ.get(prefix+'_ENDPOINT','') or os.environ.get(prefix+'_MODEL','').startswith('openrouter/'):
  if not (os.environ.get(prefix+'_API_KEY') or (prefix=='EMBEDDING' and os.environ.get('LLM_API_KEY'))): result['modelCredentialsConfigured']=False
try:
 response=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3))
 result['healthy']=response.get('status') in ('ready','ok','healthy') and not response.get('error')
except Exception: pass
try:
 db=sqlite3.connect('file:/cognee-storage/system/databases/cognee_db?mode=ro',uri=True,timeout=2)
 result['dataCount']=db.execute('SELECT COUNT(*) FROM data').fetchone()[0]
 rows=list(db.execute('SELECT pipeline_run_id,status,created_at,started_at,ended_at,outcome FROM pipeline_runs ORDER BY created_at ASC LIMIT 10000'))
 latest={}; operations=0
 for run,status,created,started,ended,outcome in rows:
  if status is not None and run: latest[run]=str(status).upper()
  elif started and not ended and not outcome: operations+=1
 result['activeRuns']=operations+sum(1 for value in latest.values() if not value.endswith(('COMPLETED','FAILED','ERRORED','CANCELLED','CANCELED')))
 result['databaseVerified']=len(rows)<10000
 db.close()
except Exception: pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise RuntimeError('redirect refused')
opener=urllib.request.build_opener(NoRedirect,urllib.request.ProxyHandler({}))
for prefix in ('LLM','EMBEDDING'):
 provider=os.environ.get(prefix+'_PROVIDER',''); endpoint=os.environ.get(prefix+'_ENDPOINT','')
 if not endpoint or provider not in ('ollama','custom','openai_compatible'): continue
 u=urllib.parse.urlsplit(endpoint)
 if u.hostname=='openrouter.ai': continue
 if u.scheme!='http' or u.hostname not in ('host.docker.internal','127.0.0.1','::1') or u.username or u.password or u.query or u.fragment:
  result['modelEndpointsReachable']=False;continue
 route=urllib.parse.urlunsplit((u.scheme,u.netloc,'/api/tags' if provider=='ollama' else '/v1/models','',''))
 try:
  headers={}; key=os.environ.get(prefix+'_API_KEY','')
  if key and provider!='ollama': headers['Authorization']='Bearer '+key
  with opener.open(urllib.request.Request(route,headers=headers),timeout=3) as response:
   body=response.read(1048577)
   if len(body)>1048576: raise RuntimeError('oversize')
   metadata=json.loads(body)
   if not isinstance(metadata,dict) or not isinstance(metadata.get('models' if provider=='ollama' else 'data'),list): raise RuntimeError('schema')
 except Exception: result['modelEndpointsReachable']=False
print(json.dumps(result))`
export function processingCommand(operation, binding, { override = true } = {}) {
  const { revision: _revision, ...identity } = binding
  binding = validateProcessingBinding(identity)
  if (operation === 'inspect-cache' || operation === 'inspect-server') return { operation, file: 'docker', args: ['exec', binding.container, 'python', '-c', operation === 'inspect-cache' ? PROCESSING_CACHE_SCRIPT : PROCESSING_SERVER_SCRIPT], cwd: binding.composeDir }
  if (operation === 'recreate') return { operation, file: 'docker', args: ['compose', '-f', binding.composeFile, ...(override ? ['-f', 'compose.override.yaml'] : []), 'up', '-d', '--no-deps', '--force-recreate', binding.service], cwd: binding.composeDir }
  fail('PROCESSING_COMMAND_INVALID')
}
export function validateProcessingCommand(spec, binding, { backupRoot } = {}) {
  if (!spec || typeof spec !== 'object') fail('PROCESSING_COMMAND_INVALID')
  if (['inspect-cache','inspect-server','recreate'].includes(spec.operation)) {
    const variants = spec.operation === 'recreate' ? [processingCommand(spec.operation,binding),processingCommand(spec.operation,binding,{override:false})] : [processingCommand(spec.operation,binding)]
    if (!variants.some(value => JSON.stringify(value) === JSON.stringify(spec))) fail('PROCESSING_COMMAND_INVALID')
  } else if (spec.operation === 'protect-private') {
    const path = spec.args?.[0], selected = validateProcessingBinding(Object.fromEntries(Object.entries(binding).filter(([key])=>key!=='revision')))
    if (!isAbsolute(path ?? '') || !selected.ownerSid || spec.file !== 'icacls.exe' || spec.cwd !== selected.composeDir || JSON.stringify(spec.args) !== JSON.stringify([path,'/inheritance:r','/grant:r',`*${selected.ownerSid}:(F)`,'*S-1-5-18:(F)'])) fail('PROCESSING_COMMAND_INVALID')
    if (![selected.composeDir,backupRoot].some(root => { if (!isAbsolute(root ?? '')) return false; const rel=relative(resolve(root),resolve(path));return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../') })) fail('PROCESSING_PRIVATE_PATH_INVALID')
  } else fail('PROCESSING_COMMAND_INVALID')
  return spec
}
function parseEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { fail('PROCESSING_ENV_UNSUPPORTED') } }
    else if (value.startsWith("'")) { if (!value.endsWith("'")) fail('PROCESSING_ENV_UNSUPPORTED'); value = value.slice(1, -1) }
    else value = value.replace(/\s+#.*$/u, '').trim()
    values[match[1]] = value
  }
  return values
}
function serverProfile(snapshot, allowed = true) {
  const env = snapshot.environment ?? {}, extraction = env.GRAPH_EXTRACTOR === 'gliner_demo'
    ? { provider: 'gliner', model: DEFAULT_PROCESSING.extraction.model }
    : serverModel(env.LLM_EXTRACTION_PROVIDER || env.LLM_PROVIDER, env.LLM_EXTRACTION_MODEL || env.LLM_MODEL, env.LLM_EXTRACTION_ENDPOINT || env.LLM_ENDPOINT, 'extraction')
  let embeddings
  if (!env.EMBEDDING_PROVIDER && !env.EMBEDDING_MODEL && snapshot.keylessLocalDefaults === true) embeddings = { ...DEFAULT_PROCESSING.embeddings }
  else embeddings = serverModel(env.EMBEDDING_PROVIDER, env.EMBEDDING_MODEL, env.EMBEDDING_ENDPOINT, 'embeddings', env.EMBEDDING_DIMENSIONS)
  return validateProcessing({ allowed, embeddings, extraction })
}
function serverModel(provider, model, endpoint, kind, dimensions) {
  let result
  if (provider === 'fastembed') result = { provider, model }
  else if (provider === 'ollama') result = { provider, model, endpoint: hostEndpoint(endpoint) }
  else if (String(model).startsWith('openrouter/') || String(endpoint).startsWith('https://openrouter.ai/')) {
    if (String(endpoint).replace(/\/$/u, '') !== 'https://openrouter.ai/api/v1') fail('PROCESSING_RUNTIME_PROFILE_UNSUPPORTED')
    result = { provider: 'openrouter', model: String(model).replace(/^openrouter\//u, '') }
  }
  else if (['custom', 'openai_compatible'].includes(provider) && endpoint) result = { provider: 'lmstudio', model: String(model).replace(/^lm_studio\//u, ''), endpoint: hostEndpoint(endpoint) }
  else fail('PROCESSING_RUNTIME_PROFILE_UNSUPPORTED')
  if (kind === 'embeddings' && dimensions) result.dimensions = Number(dimensions)
  return result
}
function hostEndpoint(endpoint) {
  const url = new URL(endpoint)
  if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1'
  if (url.pathname === '/api/embed') url.pathname = '/'
  return localModelEndpoint(url.toString(), 'ollama')
}
function containerEndpoint(endpoint, provider, suffix = '') {
  const url = new URL(localModelEndpoint(endpoint, provider)); url.hostname = 'host.docker.internal'; url.pathname = suffix || '/'; return url.toString().replace(/\/$/u, '')
}
function envForProfile(profile, source, nativeOpenRouterKey) {
  const values = parseEnv(source), next = {}, embeddings = profile.embeddings, extraction = profile.extraction
  const key = openRouterKey(values,nativeOpenRouterKey)
  if ([embeddings, extraction].some(role => role.provider === 'openrouter') && !key) fail('PROCESSING_OPENROUTER_KEY_REQUIRED')
  if (key) next.OPENROUTER_API_KEY = key
  next.GRAPH_EXTRACTOR = extraction.provider === 'gliner' ? 'gliner_demo' : 'llm'
  next.EMBEDDING_PROVIDER = embeddings.provider === 'openrouter' || embeddings.provider === 'lmstudio' ? 'openai_compatible' : embeddings.provider
  next.EMBEDDING_MODEL = embeddings.model
  if (!embeddings.dimensions) fail('PROCESSING_DIMENSIONS_REQUIRED')
  next.EMBEDDING_DIMENSIONS = String(embeddings.dimensions)
  next.EMBEDDING_ENDPOINT = embeddings.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : embeddings.provider === 'ollama' ? containerEndpoint(embeddings.endpoint, 'ollama', '/api/embed') : embeddings.provider === 'lmstudio' ? containerEndpoint(embeddings.endpoint, 'lmstudio', '/v1') : ''
  next.EMBEDDING_API_KEY = embeddings.provider === 'openrouter' ? key : embeddings.provider === 'lmstudio' ? values.LM_STUDIO_API_KEY || '.' : ''
  next.HUGGINGFACE_TOKENIZER = ''
  next.LLM_EXTRACTION_PROVIDER = ''; next.LLM_EXTRACTION_MODEL = ''; next.LLM_EXTRACTION_ENDPOINT = ''; next.LLM_EXTRACTION_API_KEY = ''
  next.LLM_EXTRACTION_API_VERSION = ''; next.LLM_API_VERSION = ''
  next.LLM_PROVIDER = extraction.provider === 'ollama' ? 'ollama' : extraction.provider === 'gliner' ? 'openai' : 'custom'
  next.LLM_MODEL = extraction.provider === 'openrouter' ? `openrouter/${extraction.model}` : extraction.provider === 'lmstudio' ? `lm_studio/${extraction.model}` : extraction.provider === 'gliner' ? '' : extraction.model
  next.LLM_ENDPOINT = extraction.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : extraction.provider === 'gliner' ? '' : containerEndpoint(extraction.endpoint, extraction.provider, extraction.provider === 'lmstudio' ? '/v1' : '')
  next.LLM_API_KEY = extraction.provider === 'openrouter' ? key : extraction.provider === 'gliner' ? '' : extraction.provider === 'lmstudio' ? values.LM_STUDIO_API_KEY || '.' : '.'
  const managed = new Set(Object.keys(next)), lines = source.split(/\r?\n/u).filter(line => !managed.has(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/u.exec(line.trim())?.[1]))
  return lines.join('\n').replace(/\n*$/u, '\n') + [...managed].map(key => `${key}=${JSON.stringify(next[key])}`).join('\n') + '\n'
}
function openRouterKey(values,nativeKey) {
  if (nativeKey !== undefined && nativeKey !== null && (typeof nativeKey !== 'string' || !/^sk-or-[A-Za-z0-9._-]{8,4090}$/u.test(nativeKey))) fail('PROCESSING_OPENROUTER_CREDENTIAL_INVALID')
  return [nativeKey,values.OPENROUTER_API_KEY,values.LLM_API_KEY,values.EMBEDDING_API_KEY].find(value=>typeof value==='string'&&/^sk-or-[A-Za-z0-9._-]{8,4090}$/u.test(value))
}
async function fileState(path, max = 256 * 1024) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail('PROCESSING_FILE_REJECTED')
    const bytes = await readFile(path); return { revision: digest(bytes), bytes }
  } catch (error) { if (error.code === 'ENOENT') return { revision: 'missing', bytes: null }; throw error }
}
async function atomicPublic(path, value, verify) {
  await verify?.(); await mkdir(dirname(path), { recursive: true }); await verify?.(); const temp = `${path}.${randomUUID()}.tmp`
  try { await verify?.(); await writeFile(temp, json(value), { flag: 'wx', mode: 0o600 }); await verify?.(); await rename(temp, path); await verify?.() } finally { await rm(temp, { force: true }) }
}
const safeRunnerResult = value => {
  if (!value || (value.code ?? value.exitCode ?? 0) !== 0 || typeof value.stdout !== 'string' || Buffer.byteLength(value.stdout) > 256 * 1024) fail('PROCESSING_NATIVE_COMMAND_FAILED')
  return value.stdout
}
export function createProcessingManager({ profilePath, bindingPath, statePath, backupRoot, runner, guard, authorize, getOpenRouterKey, fetchImpl = globalThis.fetch, defaultProfile = DEFAULT_PROCESSING, platform = process.platform, healthAttempts = 20, pollDelayMs = 1000 } = {}) {
  for (const path of [profilePath, bindingPath, statePath, backupRoot]) if (!isAbsolute(path ?? '')) fail('PROCESSING_STORAGE_PATH_REQUIRED')
  defaultProfile = validateProcessing(defaultProfile)
  let applying = false, saving = false, stateQueue = Promise.resolve()
  async function binding() {
    const row = await fileState(bindingPath, 8192)
    if (!row.bytes) return null
    const selected = validateProcessingBinding(JSON.parse(row.bytes.toString('utf8')))
    const dir = await lstat(selected.composeDir)
    if (!dir.isDirectory() || dir.isSymbolicLink()) fail('PROCESSING_COMPOSE_DIRECTORY_REJECTED')
    if (!(await fileState(join(selected.composeDir, selected.composeFile))).bytes) fail('PROCESSING_COMPOSE_FILE_REQUIRED')
    return { ...selected, revision: row.revision }
  }
  async function readState() { const row = await fileState(statePath, 32768); return row.bytes ? JSON.parse(row.bytes.toString('utf8')) : { applied: { state: 'unverified', fingerprint: null }, models: [] } }
  function updateState(update,verify) {
    const task=stateQueue.then(async()=>{await verify?.();const previous=await readState();await verify?.();const next=update(previous);await atomicPublic(statePath,next,verify);return next})
    stateQueue=task.catch(()=>{});return task
  }
  async function configuration() {
    const row = await fileState(profilePath, 8192), profile = row.bytes ? validateProcessing(JSON.parse(row.bytes.toString('utf8'))) : structuredClone(defaultProfile), state = await readState(), selected = await binding()
    let unchanged = !!selected && state.bindingRevision === selected.revision
    if (unchanged) unchanged = (await fileState(join(selected.composeDir, selected.envFile))).revision === state.envRevision && (await fileState(join(selected.composeDir, 'compose.override.yaml'))).revision === state.overrideRevision
    return { profile, revision: row.revision, bindingAvailable: !!selected, applied: { ...(state.applied ?? { state: 'unverified', fingerprint: null }), matchesDesired: unchanged && !state.credentialChanged && ['observed', 'applied'].includes(state.applied?.state) && state.applied.fingerprint === processingFingerprint(profile) } }
  }
  async function save({ profile, expectedRevision }) {
    if (applying || saving) fail('PROCESSING_BUSY')
    saving = true
    const temp = `${profilePath}.${randomUUID()}.tmp`
    try {
      const next = validateProcessing(profile), current = await configuration()
      if (current.revision !== expectedRevision) fail('PROCESSING_PROFILE_STALE')
      await mkdir(dirname(profilePath), { recursive: true }); await writeFile(temp, json(next), { flag: 'wx', mode: 0o600 })
      if ((await configuration()).revision !== expectedRevision) fail('PROCESSING_PROFILE_STALE')
      await rename(temp, profilePath); return configuration()
    } finally { saving = false; await rm(temp, { force: true }) }
  }
  async function command(operation, selected, execution, options) {
    if (typeof runner !== 'function') fail('PROCESSING_NATIVE_RUNNER_REQUIRED')
    execution?.signal?.throwIfAborted()
    return safeRunnerResult(await runner(processingCommand(operation, selected, options), execution))
  }
  async function inspectRaw(selected, execution, { verifyModels = true } = {}) {
    let result
    try { result = JSON.parse(await command('inspect-server', selected, execution)) } catch { execution?.signal?.throwIfAborted(); fail('PROCESSING_SERVER_INSPECTION_FAILED') }
    if (!/^1\.6\.7(?:-|$)/u.test(result.version ?? '') || typeof result.keylessLocalDefaults !== 'boolean' || result.remoteGliner || result.unsupportedOverrides || verifyModels && (result.modelEndpointsReachable === false || result.modelCredentialsConfigured === false) || result.healthy !== true || result.databaseVerified !== true || !Number.isSafeInteger(result.dataCount) || !Number.isSafeInteger(result.activeRuns)) fail('PROCESSING_SERVER_NOT_VERIFIED')
    return result
  }
  async function cache(selected, execution) {
    const value = JSON.parse(await command('inspect-cache', selected, execution))
    if (!Array.isArray(value.models) || value.models.length > 100) fail('PROCESSING_CACHE_INVALID')
    const models = value.models.filter(row => row && ['fastembed', 'gliner'].includes(row.provider) && ['embeddings', 'extraction'].includes(row.kind) && row.state === 'installed' && typeof row.id === 'string' && row.id.length < 241).map(({ id, provider, kind, state, dimensions }) => ({ id, provider, kind, state, ...(Number.isSafeInteger(dimensions) ? { dimensions } : {}) }))
    return models
  }
  async function attest(selected, snapshot, stateName, profile, verifiedCredentialEpoch, verify) {
    await verify?.()
    let fingerprint = null
    try { fingerprint = processingFingerprint(serverProfile(snapshot, profile.allowed)) } catch {}
    const env = await fileState(join(selected.composeDir, selected.envFile)), override = await fileState(join(selected.composeDir, 'compose.override.yaml'))
    await updateState(previous=>{
      if(verifiedCredentialEpoch!==undefined&&(previous.credentialEpoch??'missing')!==verifiedCredentialEpoch)fail('PROCESSING_CREDENTIAL_CHANGED')
      return { ...previous, ...(verifiedCredentialEpoch===undefined?{}:{credentialChanged:false}), schemaVersion: 1, bindingRevision: selected.revision, envRevision: env.revision, overrideRevision: override.revision, applied: { state: stateName, fingerprint, observedAt: new Date().toISOString(), dataCount: snapshot.dataCount, activeRuns: snapshot.activeRuns } }
    },verify)
    return configuration()
  }
  async function inspect(execution) {
    const selected = await binding(); if (!selected) fail('PROCESSING_BINDING_REQUIRED')
    const current = await configuration(), snapshot = await inspectRaw(selected, execution)
    return attest(selected, snapshot, 'observed', current.profile)
  }
  async function catalog(input, execution, verify) {
    await verify?.()
    if (['fastembed', 'gliner'].includes(input.provider)) {
      const selected = await binding()
      if (!selected) return discoverProcessingModels({ ...input, builtinModels: [] })
      try { const models = await cache(selected, execution); await updateState(state=>({ ...state, models, catalogObservedAt: new Date().toISOString() }),verify); return await discoverProcessingModels({ ...input, builtinModels: models }) }
      catch { execution?.signal?.throwIfAborted(); return { available: false, models: [], note: 'Локальный кэш Cognee не удалось проверить. Проверьте Docker и привязку сервера.' } }
    }
    return discoverProcessingModels({ ...input, signal: execution?.signal, fetchImpl })
  }
  async function invalidateCredential() {
    const current=await configuration()
    if(![current.profile.embeddings,current.profile.extraction].some(role=>role.provider==='openrouter'))return current
    await updateState(state=>({...state,credentialChanged:true,credentialEpoch:randomUUID(),applied:{...(state.applied??{}),state:'unverified'}}))
    return configuration()
  }
  async function privateWrite(path, bytes, selected, execution, verify) {
    await verify?.(); guard(execution); execution?.signal?.throwIfAborted()
    await mkdir(dirname(path), { recursive: true }); await verify?.()
    const handle = await open(path, 'wx', 0o600)
    try {
      if (platform === 'win32') {
        if (!selected.ownerSid || typeof runner !== 'function') fail('PROCESSING_PRIVATE_ACL_REQUIRED')
        await verify?.(); safeRunnerResult(await runner({ operation: 'protect-private', file: 'icacls.exe', args: [path, '/inheritance:r', '/grant:r', `*${selected.ownerSid}:(F)`, '*S-1-5-18:(F)'], cwd: selected.composeDir }, execution))
      }
      await verify?.(); guard(execution); execution?.signal?.throwIfAborted()
      await handle.writeFile(bytes); await verify?.(); await handle.sync()
    } catch (error) { await handle.close(); await rm(path, { force: true }); throw error }
    await handle.close()
  }
  async function apply({ expectedRevision, confirm, execution }, internal = {}) {
    // Application-owned authority is passed only through this non-serializable
    // internal seam. Tool arguments cannot suppress the additional confirmation.
    if (!internal || typeof internal !== 'object' || Array.isArray(internal) || Object.keys(internal).some(key=>key!=='memoryApproval')) fail('PROCESSING_MEMORY_APPROVAL_INVALID')
    const memoryApproval=internal.memoryApproval
    if (memoryApproval!==undefined && (!memoryApproval || typeof memoryApproval!=='object' || Array.isArray(memoryApproval) || Object.keys(memoryApproval).sort().join(',')!=='required,verify' || typeof memoryApproval.required!=='boolean' || typeof memoryApproval.verify!=='function')) fail('PROCESSING_MEMORY_APPROVAL_INVALID')
    const verifyMemoryApproval=async()=>{execution?.signal?.throwIfAborted();await memoryApproval?.verify();guard(execution);execution?.signal?.throwIfAborted()}
    if (applying || saving) fail('PROCESSING_BUSY')
    if (confirm !== true || typeof guard !== 'function' || typeof authorize !== 'function') fail('PROCESSING_NATIVE_APPROVAL_REQUIRED')
    applying = true; let lock, lockPath, selected, changed = false, envBefore, overrideBefore, credentialEpoch
    const recheck = async () => { await verifyMemoryApproval(); if ((await configuration()).revision !== expectedRevision || (await binding())?.revision !== selected.revision) fail('PROCESSING_PROFILE_STALE');if(((await readState()).credentialEpoch??'missing')!==credentialEpoch)fail('PROCESSING_CREDENTIAL_CHANGED');await verifyMemoryApproval() }
    try {
      await verifyMemoryApproval(); selected = await binding(); if (!selected) fail('PROCESSING_BINDING_REQUIRED')
      const current = await configuration(); if (current.revision !== expectedRevision) fail('PROCESSING_PROFILE_STALE')
      const initialState=await readState();credentialEpoch=initialState.credentialEpoch??'missing'
      const profile = current.profile, snapshot = await inspectRaw(selected, execution, { verifyModels: false })
      await recheck()
      const actual = serverProfile(snapshot, profile.allowed), same = processingFingerprint(actual) === processingFingerprint(profile), externalApi = [profile.embeddings, profile.extraction].some(role => role.provider === 'openrouter')
      if ((!same || externalApi) && snapshot.activeRuns) fail('PROCESSING_SERVER_BUSY')
      if (JSON.stringify(actual.embeddings) !== JSON.stringify(profile.embeddings) && snapshot.dataCount > 0) fail('PROCESSING_REINDEX_REQUIRED')
      if (!same) for (const kind of ['embeddings', 'extraction']) {
        const role = profile[kind], found = await catalog({ kind, ...role }, execution,recheck)
        await recheck()
        if (!found.available || !found.models.some(row => row.id === role.model)) fail('PROCESSING_SELECTED_MODEL_UNAVAILABLE')
      }
      if (await authorize(execution, { profile, restart: !same || externalApi, dataCount: snapshot.dataCount, externalApi }, {memoryApproval}) !== 'allowed-once') fail('PROCESSING_APPROVAL_REQUIRED')
      await recheck()
      let nativeKey
      if(externalApi&&typeof getOpenRouterKey==='function'){
        try {nativeKey=await getOpenRouterKey(execution)}catch{fail('PROCESSING_OPENROUTER_CREDENTIAL_UNAVAILABLE')}
        await recheck()
      }
      envBefore=await fileState(join(selected.composeDir,selected.envFile))
      if(!envBefore.bytes)fail('PROCESSING_ENV_REQUIRED')
      const sourceValues=parseEnv(envBefore.bytes.toString('utf8')),selectedKey=externalApi?openRouterKey(sourceValues,nativeKey):null
      if(externalApi&&!selectedKey)fail('PROCESSING_OPENROUTER_KEY_REQUIRED')
      const credentialRefresh=externalApi&&(initialState.envRevision!==envBefore.revision||sourceValues.OPENROUTER_API_KEY!==selectedKey||(profile.embeddings.provider==='openrouter'&&sourceValues.EMBEDDING_API_KEY!==selectedKey)||(profile.extraction.provider==='openrouter'&&sourceValues.LLM_API_KEY!==selectedKey))
      if (same && !credentialRefresh) {
        if (snapshot.modelEndpointsReachable === false || snapshot.modelCredentialsConfigured === false) fail('PROCESSING_SERVER_NOT_VERIFIED')
        const result = await attest(selected, snapshot, 'observed', profile,credentialEpoch,recheck); await recheck(); return { ...result, restarted: false }
      }
      await recheck(); lockPath = profilePath + '.apply.lock'; lock = await open(lockPath, 'wx', 0o600); await recheck()
      envBefore = await fileState(join(selected.composeDir, selected.envFile)); overrideBefore = await fileState(join(selected.composeDir, 'compose.override.yaml'))
      if (!envBefore.bytes) fail('PROCESSING_ENV_REQUIRED')
      if (overrideBefore.bytes && overrideBefore.bytes.toString('utf8') !== OVERRIDE) fail('PROCESSING_OVERRIDE_OWNED_BY_USER')
      const nextEnv = Buffer.from(envForProfile(profile, envBefore.bytes.toString('utf8'), nativeKey)), nextOverride = Buffer.from(OVERRIDE), transaction = join(backupRoot, randomUUID())
      const rel = relative(resolve(backupRoot), transaction); if (isAbsolute(rel) || rel.startsWith('..')) fail('PROCESSING_BACKUP_PATH_INVALID')
      await recheck(); await mkdir(transaction, { recursive: true }); await recheck(); await privateWrite(join(transaction, 'env.before'), envBefore.bytes, selected, execution,recheck)
      if (overrideBefore.bytes) await privateWrite(join(transaction, 'override.before'), overrideBefore.bytes, selected, execution,recheck)
      await atomicPublic(join(transaction, 'receipt.json'), { schemaVersion: 1, state: 'prepared', previousEnvRevision: envBefore.revision, previousOverrideRevision: overrideBefore.revision, desiredFingerprint: processingFingerprint(profile) },recheck)
      await updateState(prior=>{if((prior.credentialEpoch??'missing')!==credentialEpoch)fail('PROCESSING_CREDENTIAL_CHANGED');return{ ...prior, applied: { state: 'unknown', fingerprint: null }, pendingTransaction: transaction }},recheck)
      const envTemp = join(selected.composeDir, `.env.airules-${randomUUID()}.tmp`), overrideTemp = join(selected.composeDir, `.compose.airules-${randomUUID()}.tmp`)
      try {
        await privateWrite(envTemp, nextEnv, selected, execution,recheck); await privateWrite(overrideTemp, nextOverride, selected, execution,recheck)
        await recheck()
        if ((await fileState(join(selected.composeDir, selected.envFile))).revision !== envBefore.revision || (await fileState(join(selected.composeDir, 'compose.override.yaml'))).revision !== overrideBefore.revision) fail('PROCESSING_SERVER_CONFIG_STALE')
        await recheck(); await rename(envTemp, join(selected.composeDir, selected.envFile)); changed = true
        await recheck()
        await rename(overrideTemp, join(selected.composeDir, 'compose.override.yaml'))
      } finally { await rm(envTemp, { force: true }); await rm(overrideTemp, { force: true }) }
      await recheck(); await command('recreate', selected, execution)
      for (let attempt = 0; attempt < healthAttempts; attempt++) {
        await recheck()
        try {
          const live = await inspectRaw(selected, execution)
          if (processingFingerprint(serverProfile(live, profile.allowed)) === processingFingerprint(profile)) { await atomicPublic(join(transaction, 'receipt.json'), { schemaVersion: 1, state: 'applied', previousEnvRevision: envBefore.revision, previousOverrideRevision: overrideBefore.revision, desiredFingerprint: processingFingerprint(profile) },recheck); const result = await attest(selected, live, 'applied', profile,credentialEpoch,recheck); await recheck(); return { ...result, restarted: true } }
        } catch { execution?.signal?.throwIfAborted() }
        await new Promise(resolve => setTimeout(resolve, pollDelayMs))
      }
      fail('PROCESSING_SERVER_RESTART_UNCONFIRMED')
    } catch (error) {
      if (changed) {
        // Do not restart blindly after timeout/revocation. Backups + unknown
        // state retain evidence; another apply first observes the actual runtime.
        return { ...await configuration(), restarted: true, outcomeUnknown: true, error: 'PROCESSING_APPLY_OUTCOME_UNKNOWN' }
      }
      throw error
    } finally { applying = false; await lock?.close(); if (lockPath && lock) await rm(lockPath, { force: true }) }
  }
  return { configuration, save, catalog, inspect, apply, invalidateCredential }
}
