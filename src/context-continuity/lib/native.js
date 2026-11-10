import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createContinuityState, renderPacket, validateContract, projectKeyFor, keyFor, contains, safeRelative, safeSourceText, pathKey, sameScope } from './core.js'

const CUSTOM_PRESETS = ['1c-airules', 'python-airules', 'sysadmin-airules']
const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const sha = value => createHash('sha256').update(value).digest('hex')
const short = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : ''
const readKind = path => /(?:^|\/)SKILL\.md$/iu.test(path) ? 'skill' : /(?:^|\/)(?:AGENTS(?:\.local)?|CLAUDE(?:\.local)?)\.md$|(?:^|\/)rules\//iu.test(path) ? 'rule'
  : /(?:^|\/)orchestration\.json$/u.test(path) ? 'orchestration' : /(?:^|\/)session-map-[^/]+\.md$/u.test(path) ? 'session-map' : 'file'

export function resolveScope(ctx, agent) {
  const session = agent?.session, header = session?.header
  if (!session?.id || header?.id !== session.id || ctx.agents.get(session.id) !== agent || !isAbsolute(header.cwd ?? '') || !CUSTOM_PRESETS.includes(ctx.agentPresets.composedPreset(agent.ctx))) throw new Error('CONTINUITY_ACTIVE_SCOPE_REQUIRED')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (!MODES.includes(policy?.mode) || policy.sessionId !== session.id || !isAbsolute(policy.workspaceRoot ?? '') || pathKey(resolve(policy.workspaceRoot)) !== pathKey(resolve(header.cwd))) throw new Error('CONTINUITY_NATIVE_POLICY_REQUIRED')
  return { root: resolve(header.cwd), projectKey: projectKeyFor(header.cwd), sessionId: session.id, origin: header.origin === 'subagent' ? 'subagent' : 'lead', mode: policy.mode, policy, agent }
}
const coreScope = scope => ({ root: scope.root, projectKey: scope.projectKey, sessionId: scope.sessionId, origin: scope.origin })
export function retainedSurface(session) {
  if (!Array.isArray(session?.surface?.nodes) || typeof session.eventAt !== 'function' || session.surface.nodes.length > 20000) throw new Error('CONTINUITY_SURFACE_UNAVAILABLE')
  const callIds = new Set(), delivered = new Map()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/result' && typeof event.data?.message?.source?.callId === 'string') callIds.add(event.data.message.source.callId)
    if (event?.type === 'user/message' && event.data?.source?.kind === 'airules-continuity' && typeof event.data.source.compactId === 'string') delivered.set(event.data.source.compactId,event.data.source)
  }
  return { callIds, delivered }
}

/** Native service. Its only project reads/writes/processes go through injected capabilities. */
export function createNativeContinuity(ctx, { contract, mode = 'minimal', criticalFiles = [], collectGit = true, gitCommand = 'git', checkpointEveryMs = 30000, checkpointTimeoutMs = 2500,
  now = () => Date.now(), scrubbedParentEnv, createUserMessage, onDiagnostic } = {}) {
  contract = validateContract(contract)
  if (!Object.hasOwn(contract.budgets, mode) || !Array.isArray(criticalFiles) || criticalFiles.length > 2 || !Number.isSafeInteger(checkpointEveryMs) || checkpointEveryMs < 1000 || !Number.isSafeInteger(checkpointTimeoutMs) || checkpointTimeoutMs < 100 || checkpointTimeoutMs > 10000) throw new Error('CONTINUITY_CONFIG_INVALID')
  const core = createContinuityState(contract), observed = new Map(), refreshing = new Map(), loaded = new WeakSet(), metrics = { deliveries: 0, skipped: 0, errors: 0 }
  const current = (agent, before, signal) => {
    signal?.throwIfAborted()
    const after = resolveScope(ctx, agent)
    if (before && (!sameScope(before, after) || before.mode !== after.mode || JSON.stringify(before.policy)!==JSON.stringify(after.policy))) throw new Error('CONTINUITY_SCOPE_CHANGED')
    return after
  }
  // Agent.ctx is a routing carrier, not a plugin declaring fs injection.
  // Resolve the mounted preset service through the public registry contract.
  const fsOf = scope => ctx.agentPresets.serviceFor?.(scope.agent,'fs') ?? ctx.fs
  async function checkedTarget(scope, path, signal, { metadata = false, absent = false } = {}) {
    const rel = safeRelative(scope.root, path, { metadata })
    if (!rel) throw new Error('CONTINUITY_PATH_REJECTED')
    const fs = fsOf(scope)
    if (!fs || typeof fs.lstat !== 'function' || typeof fs.processPath !== 'function') throw new Error('CONTINUITY_FS_UNAVAILABLE')
    const rootTarget = await fs.resolve(scope.root, { cwd: scope.root, signal })
    current(scope.agent, scope, signal)
    if (pathKey(fs.processPath(rootTarget)) !== pathKey(scope.root)) throw new Error('CONTINUITY_LINK_REJECTED')
    let at = scope.root
    for (const part of rel.split('/')) {
      at = join(at, part)
      const row = await fs.lstat(at, { cwd: scope.root, signal }, signal)
      current(scope.agent, scope, signal)
      if (row?.type === 'symlink') throw new Error('CONTINUITY_LINK_REJECTED')
      if (!row && !absent) throw new Error('CONTINUITY_NOT_FOUND')
    }
    const target = await fs.resolve(join(scope.root, rel), { cwd: scope.root, signal })
    current(scope.agent, scope, signal)
    if (!contains(scope.root, fs.processPath(target)) || pathKey(fs.processPath(target)) !== pathKey(join(scope.root, rel))) throw new Error('CONTINUITY_LINK_REJECTED')
    return { fs, target, rel }
  }
  async function read(scope, path, maxBytes, signal, options) {
    const { fs, target, rel } = await checkedTarget(scope, path, signal, options), before = await fs.stat(target, signal)
    current(scope.agent, scope, signal)
    if (before?.type !== 'file' || typeof before.version !== 'string' || !Number.isSafeInteger(before.size) || before.size > maxBytes) throw new Error('CONTINUITY_FILE_LIMIT')
    const value = Buffer.from(await fs.readBytes(target, signal, maxBytes + 1))
    current(scope.agent, scope, signal)
    const after = await fs.stat(target, signal)
    current(scope.agent, scope, signal)
    if (after?.version !== before.version || value.length > maxBytes) throw new Error('CONTINUITY_FILE_CHANGED')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value)
    if (!safeSourceText(text, maxBytes)) throw new Error('CONTINUITY_SOURCE_REJECTED')
    return { path: rel, text, version: after.version }
  }
  async function discoverRefs(scope, signal) {
    if (scope.origin === 'subagent') return []
    const refs = []
    for (const path of ['var/tmp/orchestration.json']) try {
      const { fs, target, rel } = await checkedTarget(scope, path, signal), info = await fs.stat(target, signal)
      current(scope.agent, scope, signal)
      if (info?.type === 'file') refs.push({ kind: 'orchestration', path: rel, version: short(info.version, 128) })
    } catch {}
    try {
      const { fs, target } = await checkedTarget(scope, 'var/tmp', signal), entries = await fs.listDir(target, signal)
      current(scope.agent, scope, signal)
      if (!Array.isArray(entries) || entries.length > 500) return refs
      const names = entries.filter(row => row.type === 'file' && /^session-map-[a-zA-Z0-9._-]+\.md$/u.test(row.name)).slice(0, 5)
      for (const row of names) refs.push({ kind: 'session-map', path: `var/tmp/${row.name}`, version: short(row.version, 128) })
    } catch {}
    return refs
  }
  async function git(scope, signal) {
    if (!collectGit || !ctx.subprocess || !ctx.sandbox || typeof scrubbedParentEnv !== 'function') return { state: 'unavailable', reason: 'NATIVE_GIT_UNAVAILABLE' }
    const env = { ...scrubbedParentEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
    let command
    try { command = await ctx.subprocess.resolveExecutable(gitCommand, env, signal) } catch { return { state: 'unavailable', reason: 'GIT_EXECUTABLE_UNAVAILABLE' } }
    current(scope.agent, scope, signal)
    async function run(args, limit = 4096) {
      const argv = [command, '--no-optional-locks', '-C', scope.root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args]
      const policy = { ...scope.policy, mode: 'read-only' }, facts = await ctx.sandbox.confine(argv, policy, signal)
      current(scope.agent, scope, signal)
      if (!Array.isArray(facts?.argv) || !facts.argv.length) throw new Error('CONTINUITY_GIT_CONFINEMENT')
      const handle = ctx.subprocess.spawn({ argv: facts.argv, cwd: scope.root, env, signal, graceMs: 200, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      let output = Buffer.alloc(0), overflow = false
      handle.stdout.on('data', chunk => { const value = Buffer.from(chunk); if (output.length + value.length > limit) { overflow = true; void handle.terminate() } else output = Buffer.concat([output, value]) })
      handle.stderr.on('data', () => {})
      try { const result = await handle.done; const stopped = await handle.waitForExit(signal); current(scope.agent, scope, signal); if (overflow || stopped !== true || result.exitCode !== 0) throw new Error('CONTINUITY_GIT_UNAVAILABLE'); return output.toString('utf8').trimEnd() }
      catch (error) { try { await handle.terminate(); await handle.waitForExit(AbortSignal.timeout(1000)) } catch {} throw error }
    }
    try {
      const head = await run(['rev-parse', 'HEAD'], 128)
      if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new Error('CONTINUITY_GIT_INVALID')
      const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], 256).catch(() => '(detached)')
      const status = await run(['status', '--porcelain=v1', '--untracked-files=no'], 4096)
      const stat = await run(['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD'], 2048)
      return { state: 'complete', head, branch: short(branch, 128), changedPaths: status.split(/\r?\n/u).filter(Boolean).slice(0, 20).map(row => short(row, 240)), diffstat: stat.split(/\r?\n/u).slice(-2).map(row => short(row, 240)).join('\n') }
    } catch { return { state: 'partial', reason: 'NATIVE_GIT_INCOMPLETE' } }
  }
  async function openspec(scope, signal) {
    try {
      const fs=fsOf(scope),info=await fs.lstat(join(scope.root,'openspec','changes'),{cwd:scope.root,signal},signal)
      current(scope.agent,scope,signal)
      if(!info)return {state:'complete',rows:[]}
      const checked=await checkedTarget(scope,'openspec/changes',signal),entries=await checked.fs.listDir(checked.target,signal)
      current(scope.agent,scope,signal)
      if(!Array.isArray(entries)||entries.length>500)throw new Error('CONTINUITY_OPENSPEC_LIMIT')
      const rows=[],directories=entries.filter(row=>row.type==='directory'&&/^[a-zA-Z0-9._-]+$/u.test(row.name)&&row.name!=='archive')
      let partial=directories.length>10
      for(const row of directories.slice(0,10))try{
        const file=await read(scope,`openspec/changes/${row.name}/tasks.md`,65536,signal)
        const tasks=file.text.split(/\r?\n/u).filter(line=>/^\s*[-*]\s+\[[ xX]\]/u.test(line))
        rows.push({path:file.path,version:file.version,total:tasks.length,done:tasks.filter(line=>/^\s*[-*]\s+\[[xX]\]/u.test(line)).length})
      }catch{partial=true}
      return {state:partial?'partial':'complete',rows}
    }catch{return {state:'unavailable',rows:[]}}
  }
  async function load(scope, state, signal) {
    if (loaded.has(state)) return
    loaded.add(state)
    const path = `var/tmp/continuity/${keyFor(scope.sessionId)}/checkpoint.json`
    try {
      const { text } = await read(scope, path, contract.limits.checkpointBytes, signal), checkpoint = JSON.parse(text)
      if (checkpoint.schemaVersion !== 1 || !sameScope(checkpoint, coreScope(scope)) || typeof checkpoint.capturedAt !== 'string' || !Array.isArray(checkpoint.refs) || checkpoint.refs.length > contract.limits.refs) return
      state.checkpoint = { path, capturedAt: checkpoint.capturedAt, state: 'historical', durable: true, git: checkpoint.git, openspec:checkpoint.openspec }
      // Restore metadata only; lifecycle must still prove an actual new successful compaction.
      for (const ref of [...checkpoint.refs,...(checkpoint.files??[])]) if (ref && typeof ref.path === 'string' && typeof ref.callId === 'string' && typeof ref.kind === 'string' && (ref.path.startsWith('airules_rule:') || ref.path.startsWith('domain_rule:') || safeRelative(scope.root, ref.path, { metadata: true }))) core.observe(coreScope(scope), {...ref,restorable:false})
    } catch {}
    // Restart recovery is based on the native journal, never a JSON compact claim.
    // Only the last successful compact at the tail is eligible; later conversation
    // or tool activity makes that historical compact ineligible.
    if (Array.isArray(scope.agent.session.log) && scope.agent.session.log.length <= 20000) {
      const log=scope.agent.session.log, startAt=scope.agent.session.inheritedEventCount??0
      const end=log.findLast(row=>row.seq>=startAt&&row.type==='compaction/end')
      const start=end&&log.findLast(row=>row.seq>=startAt&&row.seq<end.seq&&row.type==='compaction/start'&&row.data?.compactionId===end.data?.compactionId)
      if(start&&end&&!end.data?.error&&!log.some(row=>row.seq>end.seq&&['user/message','assistant/message','tool/result','compaction/start'].includes(row.type))) {
        const calls=new Set(log.filter(row=>row.seq<start.seq&&row.type==='tool/result').map(row=>row.data?.message?.source?.callId).filter(Boolean))
        core.start(coreScope(scope),{id:start.data.compactionId,sourceSeq:start.seq,retainedCallIds:calls})
        core.end(coreScope(scope),{id:end.data.compactionId,sourceSeq:end.seq})
      }
    }
  }
  async function refresh(agent, signal, force = false) {
    const scope = current(agent, null, signal), state = core.ensure(coreScope(scope))
    if (mode === 'off') return null
    if (refreshing.has(scope.sessionId)) return refreshing.get(scope.sessionId)
    if (!force && state.lastRefresh && now() - state.lastRefresh < checkpointEveryMs) return state.checkpoint
    const operation = (async () => {
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), checkpointTimeoutMs), combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
      try {
        await load(scope, state, combined)
        const capturedAt = new Date(now()).toISOString(), gitState = await git(scope, combined), refs = await discoverRefs(scope, combined),spec=await openspec(scope,combined)
        current(agent, scope, combined)
        const cleanRef = row => ({kind:row.kind,path:row.path.slice(0,512),version:row.version??'',...(row.id?{id:row.id}:{}),...(row.callId?{callId:row.callId}:{})})
        const {state:gitStatus,reason,...gitData}=gitState
        const checkpoint = { schemaVersion: 1, projectKey:scope.projectKey, sessionId:scope.sessionId, origin:scope.origin, capturedAt, generation:String(state.generation), state: gitStatus === 'complete'&&spec.state==='complete' ? 'complete' : 'partial', git: gitData, refs: [...state.refs, ...refs].filter(row=>row.kind!=='file').slice(-contract.limits.refs).map(cleanRef), files:state.reads.map(cleanRef), openspec:spec.rows, limitations: [...(reason?[reason]:[]),...(spec.state!=='complete'?['OPENSPEC_PARTIAL_OR_UNAVAILABLE']:[])] }
        while(Buffer.byteLength(JSON.stringify(checkpoint)+'\n')>contract.limits.checkpointBytes && (checkpoint.refs.length||checkpoint.files.length||checkpoint.openspec.length)) { checkpoint.state='partial'; if(checkpoint.refs.length)checkpoint.refs.shift();else if(checkpoint.files.length)checkpoint.files.shift();else checkpoint.openspec.shift() }
        const path = `var/tmp/continuity/${keyFor(scope.sessionId)}/checkpoint.json`
        state.discovered = refs
        state.checkpoint = { path, capturedAt, state: checkpoint.state, durable: false, git: gitData, openspec:spec.rows,limitations:checkpoint.limitations }
        if (scope.mode !== 'read-only') try {
          const text = JSON.stringify(checkpoint) + '\n'
          if (Buffer.byteLength(text) > contract.limits.checkpointBytes) throw new Error('CONTINUITY_CHECKPOINT_LIMIT')
          const { fs, target } = await checkedTarget(scope, path, combined, { absent: true }), before = await fs.stat(target, combined)
          current(agent, scope, combined)
          await fs.writeText(target, text, before ? { kind: 'replaceIfVersion', version: before.version } : { kind: 'createIfAbsent' }, combined, scope.policy)
          current(agent, scope, combined)
          state.checkpoint.durable = true
        } catch (error) { try { onDiagnostic?.(error) } catch {} state.checkpoint.reason = 'NATIVE_CHECKPOINT_WRITE_UNAVAILABLE';state.checkpoint.reasonCode=/^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code??'')?error.code:/^CONTINUITY_[A-Z_]+$/u.test(error?.message??'')?error.message:error?.name??'Error' }
        return state.checkpoint
      } catch { state.checkpoint ??= { path: null, capturedAt: new Date(now()).toISOString(), state: 'unavailable', durable: false }; return state.checkpoint }
      finally { clearTimeout(timer); state.lastRefresh = now() }
    })()
    refreshing.set(scope.sessionId, operation)
    try { return await operation } finally { if (refreshing.get(scope.sessionId) === operation) refreshing.delete(scope.sessionId) }
  }
  function fsObserved(target, observation, exec) {
    if (!exec?.agent || exec.name !== 'read' || observation?.kind !== 'present') return
    try {
      const scope = resolveScope(ctx, exec.agent), fs = fsOf(scope), path = safeRelative(scope.root, fs.processPath(target), { metadata: true })
      if (path) observed.set(`${scope.sessionId}:${exec.rootCallId ?? exec.callId}`, { path, version: short(observation.version, 128), scope:coreScope(scope), policy:JSON.stringify(scope.policy),agent:exec.agent })
      while (observed.size > 100) observed.delete(observed.keys().next().value)
    } catch {}
  }
  function toolResult(exec, result) {
    if (result?.isError || !exec?.agent) return
    try {
      const scope = resolveScope(ctx, exec.agent), compactScope = coreScope(scope), callId = exec.rootCallId ?? exec.callId
      if (typeof callId !== 'string') return
      if (exec.name === 'read') {
        const candidate = observed.get(`${scope.sessionId}:${callId}`)
        const receipt = candidate && candidate.agent===exec.agent && sameScope(candidate.scope,compactScope) && candidate.policy===JSON.stringify(scope.policy) ? candidate : null
        const path = receipt?.path ?? safeRelative(scope.root, result.value?.path ?? exec.arguments?.file_path, { metadata: true })
        observed.delete(`${scope.sessionId}:${callId}`)
        if (path) core.observe(compactScope, { kind: readKind(path), path, callId, version: receipt?.version ?? '', restorable:!!receipt })
      } else if (['airules_rule', 'domain_rule', 'skill'].includes(exec.name)) {
        const id = exec.arguments?.id ?? exec.arguments?.name
        if (typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,119}$/u.test(id)) {
          const text = result.value?.text ?? result.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') ?? ''
          core.observe(compactScope, { kind: exec.name === 'skill' ? 'skill' : 'rule', id, path: `${exec.name}:${id}`, callId, version: text ? sha(text) : '' })
        }
      }
      for (const key of ['artifactPath', 'spillPath', 'outputPath', 'fullOutputPath']) {
        const value = result.value?.[key] ?? result.value?.details?.[key]
        const path = safeRelative(scope.root, value)
        if (path) core.artifact(compactScope, { path, callId })
      }
    } catch {}
  }
  function event(session, event) {
    try {
      const agent = ctx.agents.get(session.id), scope = resolveScope(ctx, agent)
      if (scope.agent.session !== session) return
      const selected = coreScope(scope)
      if (event?.type === 'compaction/start') core.start(selected, { id: event.data?.compactionId, sourceSeq: event.seq, retainedCallIds: retainedSurface(session).callIds })
      if (event?.type === 'compaction/end') core.end(selected, { id: event.data?.compactionId, sourceSeq: event.seq, failed: !!event.data?.error })
      if (event?.type === 'user/message' && event.data?.source?.kind === 'airules-continuity') {
        const source=event.data.source,state=core.ensure(selected),pending=state.pending
        if(pending && source.compactId===pending.id && source.generation===pending.generation && source.projectKey===scope.projectKey && source.sessionId===scope.sessionId && core.delivered(selected,pending)) metrics.deliveries++
      }
    } catch {}
  }
  async function restore(agent, signal, decision) {
    if (!decision || decision.kind === 'reject' || signal?.aborted || mode === 'off') return decision
    let scope, state, pending
    try {
      scope = current(agent, null, signal); state = core.ensure(coreScope(scope)); pending = state.pending
      if (!pending) return decision
      const retained = retainedSurface(agent.session)
      const ack=retained.delivered.get(pending.id)
      if (ack?.projectKey===scope.projectKey && ack.sessionId===scope.sessionId && ack.generation===pending.generation) { core.delivered(coreScope(scope), pending); return decision }
      const refs = pending.refs.filter(ref => !retained.callIds.has(ref.callId)), files = []
      if (mode !== 'minimal') for (const row of pending.reads) {
        if (files.length >= contract.limits.restoreFiles) break
        if (retained.callIds.has(row.callId) || !safeRelative(scope.root, row.path) || ![...criticalFiles, ...state.critical].includes(row.path)) continue
        try { const value = await read(scope, row.path, contract.limits.perFileBytes, signal); files.push({ ...value, previousVersion: row.version, critical: true, lost: true, allowed: true }) } catch {}
      }
      current(agent, scope, signal)
      const jobs = (ctx.jobs?.list(scope.sessionId) ?? []).filter(row => row.owner === scope.sessionId && ['running', 'stopping', 'queued'].includes(row.status))
      const packet = renderPacket(contract, { mode, scope: coreScope(scope), compact: { id: pending.id, complete: true, failed: false }, checkpointScope: coreScope(scope), refs: [...refs, ...(state.discovered ?? [])], files, checkpoint: state.checkpoint, jobs, artifacts: state.artifacts })
      current(agent, scope, signal)
      if (!packet.deliver || state.pending !== pending || typeof createUserMessage !== 'function') return decision
      const message = createUserMessage({ content: [{ type: 'text', text: packet.text }], source: { kind: 'airules-continuity', compactId: pending.id, projectKey: scope.projectKey, sessionId: scope.sessionId, generation: pending.generation, checkpointTime: state.checkpoint?.capturedAt ?? null } })
      // Returning a candidate is not publication. Only the native user/message
      // event (or retained native receipt on retry) acknowledges delivery.
      return { ...decision, messages: [...(decision.messages??[]), message] }
    } catch { metrics.errors++; return decision }
  }
  return {
    fsObserved, toolResult, event, restore, refresh,
    async preStep(payload, next) {
      try { resolveScope(ctx, payload.agent); if (mode !== 'off') await refresh(payload.agent, payload.signal) } catch {}
      const decision = await next()
      return restore(payload.agent, payload.signal, decision)
    },
    async act(args, exec) {
      const scope = current(exec?.agent, null, exec?.signal), state = core.ensure(coreScope(scope))
      if (args.action === 'mark') {
        if (!Array.isArray(args.paths) || args.paths.length > 2) throw new Error('CONTINUITY_MARK_INVALID')
        for (const path of args.paths) if (!safeRelative(scope.root, path) || !state.reads.some(row => row.path === path)) throw new Error('CONTINUITY_READ_FIRST')
        state.critical = new Set(args.paths)
      } else if (args.action === 'checkpoint') await refresh(scope.agent, exec.signal, true)
      else if (args.action !== undefined && args.action !== 'status') throw new Error('CONTINUITY_ACTION_INVALID')
      return { mode, scope: coreScope(scope), pendingCompactId: state.pending?.id ?? null, trackedReads: state.reads.length, trackedInstructions: state.refs.filter(row => row.kind !== 'file').length,
        criticalFiles: [...state.critical], checkpoint: state.checkpoint, capabilities: { exactCompactId: true, durableCheckpoint: !!state.checkpoint?.durable, freshFileRestore: mode !== 'minimal' && mode !== 'off', noModelCalls: true, noMemoryWrites: true }, metrics: { ...metrics } }
    },
  }
}
