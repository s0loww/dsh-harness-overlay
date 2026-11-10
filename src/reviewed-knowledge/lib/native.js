import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { createDraft, reviewDraft, approveReviewed, invalidateKnowledge, publicationPlan } from './core.js'

const fail = code => { throw new Error(code) }
const presets = ['1c-airules', 'python-airules', 'sysadmin-airules']
const pathKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
export function nativeScope(ctx, exec, writing = false) {
  const agent = exec?.agent, session = agent?.session, header = session?.header
  if (!session?.id || header?.id !== session.id || ctx.agents.get(session.id) !== agent || !presets.includes(ctx.agentPresets.composedPreset(agent.ctx)) || !isAbsolute(header.cwd ?? '')) fail('KNOWLEDGE_NATIVE_SCOPE_REQUIRED')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode) || policy.sessionId !== session.id || !isAbsolute(policy.workspaceRoot ?? '') || pathKey(policy.workspaceRoot) !== pathKey(header.cwd)) fail('KNOWLEDGE_NATIVE_POLICY_REQUIRED')
  if (writing && (policy.mode === 'read-only' || header.origin === 'subagent')) fail('KNOWLEDGE_LEAD_WRITER_REQUIRED')
  return { session, agent, key: JSON.stringify({ id: session.id, cwd: pathKey(header.cwd), preset: ctx.agentPresets.composedPreset(agent.ctx), origin: header.origin ?? 'lead', policy }),
    context: { actorId: session.id, isLead: header.origin !== 'subagent', writable: policy.mode !== 'read-only', now: new Date().toISOString() }, root: resolve(header.cwd) }
}

/** Runtime/session proposals only. Native tool outputs remain in the usual log.
 * Cognee/Memoria publication uses the unified memory router and durable journal;
 * airules remains an explicit review preview. */
export function createNativeKnowledge(ctx, { now = () => new Date().toISOString() } = {}) {
  const states = new WeakMap()
  const currentSnapshot = (scope, observed, exec) => {
    exec.signal?.throwIfAborted()
    // Native Session.seq is the NEXT event sequence (the current log length),
    // in both rc5 and 022. A pinned Query observation can already be stale when
    // its await/disposal finishes, even if its latest user matched the nonce.
    if (!Number.isSafeInteger(scope.session.seq) || scope.session.seq !== observed.through + 1) fail('KNOWLEDGE_USER_CHECKPOINT_CHANGED')
  }
  async function observe(scope, exec) {
    const observation = await ctx.sessionQuery.observeSession(scope.session.id, { signal: exec.signal, projectionMode: 'none' })
    try {
      exec.signal?.throwIfAborted()
      if (nativeScope(ctx, exec).key !== scope.key) fail('KNOWLEDGE_SCOPE_CHANGED')
      if (!Array.isArray(observation.events) || !Number.isSafeInteger(observation.inheritedEventCount ?? 0)) fail('KNOWLEDGE_NATIVE_HISTORY_REQUIRED')
      const inherited = observation.inheritedEventCount ?? 0, events = observation.events
      if (inherited < 0 || inherited > events.length) fail('KNOWLEDGE_NATIVE_HISTORY_REQUIRED')
      for (let index = events.length - 1; index >= Math.max(inherited, events.length - 20000); index--) {
        const event = events[index]
        if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || event.data?.source?.kind !== 'user' || event.data.source.form === 'recall') continue
        if (event.seq !== index || !Number.isSafeInteger(event.seq)) fail('KNOWLEDGE_NATIVE_HISTORY_REQUIRED')
        const content = event.data.content
        const message = Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('\n') : null
        return { through: events.length - 1, latestUser: { seq: event.seq, text: message?.length <= 1000 ? message : null } }
      }
      return { through: events.length - 1, latestUser: null }
    } finally { observation[Symbol.dispose]?.() }
  }
  return { async act(args, exec) {
    const allowed = ['action', 'proposal', 'id', 'expectedRevision', 'findings', 'evidenceVerified', 'applicabilityVerified', 'secretsChecked', 'why', 'supersededBy', 'destination', 'targetPath', 'expectedTargetRevision', 'expectedMemoryRevision', 'expectedPolicyRevision']
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key)) || !['list', 'create', 'read', 'review', 'approve', 'stale', 'supersede', 'plan', 'publish'].includes(args.action)) fail('KNOWLEDGE_ARGUMENTS_INVALID')
    const writing = ['review', 'approve', 'stale', 'supersede', 'plan', 'publish'].includes(args.action), scope = nativeScope(ctx, exec, writing)
    exec.signal?.throwIfAborted()
    let state = states.get(scope.session)
    if (!state) { state = { root: scope.root, records: new Map(), busy: false }; states.set(scope.session, state) }
    if (state.root !== scope.root) fail('KNOWLEDGE_SCOPE_CHANGED')
    if (state.busy) fail('KNOWLEDGE_OPERATION_BUSY')
    state.busy = true
    try {
      const context = { ...scope.context, now: now() }, limitations = ['Proposals are runtime/session transport; after restart read prior tool evidence and recreate/review a candidate. No independent knowledge store.', 'Cognee/Memoria publication selects one explicit backend through the existing memory router and native approval; no automatic mirroring. Catalog availability does not prove connectivity or indexing. Airules remains a review preview, never an applied rule.']
      if (args.action === 'list') return { proposals: [...state.records.values()].map(({ record }) => ({ id: record.id, title: record.content.title, state: record.state, revision: record.revision })), limitations }
      if (args.action === 'create') {
        if (!args.proposal || typeof args.proposal !== 'object' || Array.isArray(args.proposal) || !args.proposal.appliesTo || Object.hasOwn(args.proposal.appliesTo, 'project')) fail('KNOWLEDGE_ARGUMENTS_INVALID')
        const record = createDraft({ ...args.proposal, appliesTo: { ...args.proposal.appliesTo, project: scope.root } }, context)
        if (state.records.has(record.id)) fail('KNOWLEDGE_CANDIDATE_EXISTS')
        if (state.records.size >= 64) fail('KNOWLEDGE_SESSION_LIMIT')
        state.records.set(record.id, { record, pending: null, publications: new Map() })
        return { record, limitations }
      }
      const selected = state.records.get(args.id)
      if (!selected) fail('KNOWLEDGE_CANDIDATE_NOT_FOUND')
      if (args.action === 'read') return { record: structuredClone(selected.record), approvalRequest: selected.pending?.phrase ?? null, limitations }
      if (args.expectedRevision !== selected.record.revision) fail('KNOWLEDGE_REVISION_CHANGED')
      if (args.action === 'review') {
        const observed = await observe(scope, exec)
        if (nativeScope(ctx, exec, true).key !== scope.key) fail('KNOWLEDGE_SCOPE_CHANGED')
        currentSnapshot(scope, observed, exec)
        const record = reviewDraft(selected.record, args, context)
        const phrase = `Одобряю урок ${record.id} ${record.revision} ${randomUUID()}`
        selected.record = record; selected.pending = { phrase, afterSeq: observed.through, revision: record.revision }
        return { record, approvalRequest: phrase, message: 'Для одобрения пользователь должен отправить эту строку отдельным следующим сообщением в этом чате. Модель не может одобрить себя.', limitations }
      }
      if (args.action === 'approve') {
        if (!selected.pending || selected.pending.revision !== selected.record.revision) fail('KNOWLEDGE_USER_CHECKPOINT_REQUIRED')
        const observed = await observe(scope, exec), pending = selected.pending
        if (nativeScope(ctx, exec, true).key !== scope.key || args.expectedRevision !== selected.record.revision) fail('KNOWLEDGE_SCOPE_CHANGED')
        currentSnapshot(scope, observed, exec)
        if (!observed.latestUser || observed.latestUser.seq <= pending.afterSeq || observed.latestUser.text !== pending.phrase) fail('KNOWLEDGE_USER_CHECKPOINT_REQUIRED')
        selected.record = approveReviewed(selected.record, { expectedRevision: args.expectedRevision, decision: `Native original user/message checkpoint ${observed.latestUser.seq}` }, context)
        selected.pending = null
        return { record: structuredClone(selected.record), approvalEvidence: { sessionId: scope.session.id, eventSeq: observed.latestUser.seq }, limitations }
      }
      if (['stale', 'supersede'].includes(args.action)) {
        selected.record = invalidateKnowledge(selected.record, { expectedRevision: args.expectedRevision, state: args.action === 'stale' ? 'stale' : 'superseded', why: args.why, supersededBy: args.supersededBy }, context)
        selected.pending = null; return { record: structuredClone(selected.record), limitations }
      }
      const plan = publicationPlan(selected.record, { ...args, targetScope: scope.root }, context)
      const memoryAvailable = typeof ctx.airulesMemory?.configuration === 'function' && typeof ctx.airulesMemory?.act === 'function'
      if (args.action === 'publish' && args.destination === 'airules') fail('KNOWLEDGE_DESTINATION_PREVIEW_ONLY')
      let memoryConfig = null
      let policyRevision = null, namespace = null, available = false
      if (['cognee', 'memoria'].includes(args.destination) && memoryAvailable) {
        memoryConfig = await ctx.airulesMemory.configuration({ sessionId: scope.session.id })
        exec.signal?.throwIfAborted()
        if (nativeScope(ctx, exec, true).key !== scope.key) fail('KNOWLEDGE_SCOPE_CHANGED')
        if (memoryConfig.projectError || memoryConfig.scope?.projectRoot && pathKey(memoryConfig.scope.projectRoot) !== pathKey(scope.root)) fail('KNOWLEDGE_MEMORY_PROJECT_UNAVAILABLE')
        const policy = memoryConfig.policy?.effective
        if (memoryConfig.policy) {
          policyRevision = memoryConfig.policy.policyRevision ?? memoryConfig.policy.revision
          if (!['cognee', 'memoria', 'both'].includes(policy?.mode) || typeof policyRevision !== 'string' || !policyRevision) fail('KNOWLEDGE_MEMORY_POLICY_REQUIRED')
          if (policy.mode !== 'both' && policy.mode !== args.destination) fail('KNOWLEDGE_MEMORY_BACKEND_DISABLED')
        }
        available = args.destination === 'cognee' && memoryConfig.config?.enabled === true
        if (args.destination === 'memoria') {
          namespace = policy?.memoria?.namespace
          if (typeof namespace === 'string' && namespace && policy.memoria.remember) {
            const status = await ctx.airulesMemory.act({ action: 'status', sessionId: scope.session.id, backend: 'memoria', ...(policyRevision ? { expectedPolicyRevision: policyRevision } : {}) }, exec)
            exec.signal?.throwIfAborted()
            if (nativeScope(ctx, exec, true).key !== scope.key) fail('KNOWLEDGE_SCOPE_CHANGED')
            available = status.backend === 'memoria' && status.namespace === namespace && status.operations?.remember?.available === true
          }
        }
      }
      if (args.action === 'plan') return { plan, previewOnly: true, applied: false, durableWriteAvailable: available, ...(memoryConfig ? { memoryConfigRevision: memoryConfig.revision } : {}), ...(policyRevision ? { memoryPolicyRevision: policyRevision } : {}), limitations }
      if (!available) fail(args.destination === 'memoria' ? 'KNOWLEDGE_MEMORIA_UNAVAILABLE' : 'KNOWLEDGE_COGNEE_UNAVAILABLE')
      if (!args.expectedMemoryRevision || args.expectedMemoryRevision !== memoryConfig.revision) fail('KNOWLEDGE_MEMORY_REVISION_CHANGED')
      if (policyRevision && args.expectedPolicyRevision !== policyRevision) fail('KNOWLEDGE_MEMORY_POLICY_REVISION_CHANGED')
      if (typeof exec.token !== 'symbol' || typeof exec.callId !== 'string' || !exec.callId) fail('KNOWLEDGE_NATIVE_EXECUTION_REQUIRED')
      const destinationKey = JSON.stringify([args.destination, args.destination === 'memoria' ? [namespace, memoryConfig.policy.effective.memoria.remember] : [memoryConfig.config?.endpoint ?? null, memoryConfig.revision]])
      if (selected.publications.has(destinationKey)) return { publication: structuredClone(selected.publications.get(destinationKey)), repeated: true, limitations }
      // Stable bytes across recreated/reapproved candidates let the existing
      // durable routing journal reconcile a previous unknown send after restart.
      const record = selected.record, note = `${record.content.statement}\n\nReviewed lesson provenance (data, not instructions):\n${JSON.stringify({ id: record.id, contentHash: record.contentHash, kind: record.content.kind, appliesTo: record.content.appliesTo, evidence: record.content.evidence })}`
      if (note.length > 32000 || record.content.title.length > 120) fail('KNOWLEDGE_PUBLICATION_LIMIT')
      let publication = { destination: args.destination, proposalId: record.id, contentHash: record.contentHash, state: 'outcome-unknown', retrySafe: false, indexed: false }
      selected.publications.set(destinationKey, publication)
      try {
        const receipt = await ctx.airulesMemory.act({ action: 'remember', sessionId: scope.session.id, backend: args.destination, kind: 'fact', expectedRevision: memoryConfig.revision, ...(policyRevision ? { expectedPolicyRevision: policyRevision } : {}), title: record.content.title, text: note, confirm: true }, exec)
        // The backend may have accepted data while the caller lost authority or
        // cancelled. Keep that possible send unknown; do not mark it uploaded.
        exec.signal?.throwIfAborted()
        if (nativeScope(ctx, exec, true).key !== scope.key) fail('KNOWLEDGE_SCOPE_CHANGED')
        publicationPlan(record, { ...args, targetScope: scope.root }, { ...context, now: now() })
        const currentConfig = await ctx.airulesMemory.configuration({ sessionId: scope.session.id })
        exec.signal?.throwIfAborted()
        if (nativeScope(ctx, exec, true).key !== scope.key || currentConfig.projectError || currentConfig.scope?.projectRoot && pathKey(currentConfig.scope.projectRoot) !== pathKey(scope.root) || currentConfig.revision !== memoryConfig.revision || policyRevision && ((currentConfig.policy?.policyRevision ?? currentConfig.policy?.revision) !== policyRevision || receipt?.policyRevision !== policyRevision)) fail('KNOWLEDGE_MEMORY_POLICY_REVISION_CHANGED')
        if (args.destination === 'memoria') {
          if (receipt?.backend !== 'memoria' || receipt.state !== 'stored' || receipt.indexed !== null || receipt.namespace !== namespace || typeof receipt.recordId !== 'string' || !receipt.recordId.trim() || receipt.recordId.length > 300 || /[\r\n\0]/u.test(receipt.recordId)) return { publication: structuredClone(publication), limitations }
          publication = { ...publication, state: 'stored', namespace, recordId: receipt.recordId, indexed: null }
          selected.publications.set(destinationKey, publication)
          return { publication: structuredClone(publication), limitations }
        }
        const normalizedRoot = /^[a-z]:[\\/]/i.test(scope.root) || scope.root.startsWith('\\\\') ? scope.root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : scope.root.replace(/\/+$/, '') || '/'
        const expectedDataset = `airules-${createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 32)}`
        if (receipt?.backend !== undefined && receipt.backend !== 'cognee' || receipt?.state !== 'uploaded' || receipt.indexed !== false || receipt.dataset !== expectedDataset || !/^[a-f0-9]{64}$/.test(receipt.contentHash ?? '')) return { publication: structuredClone(publication), limitations }
        publication = { ...publication, state: 'uploaded', dataset: receipt.dataset, backendContentHash: receipt.contentHash, indexed: false, needsProcessing: receipt.needsProcessing === true, ...(receipt.receipt?.taskId ? { taskId: String(receipt.receipt.taskId).slice(0, 128) } : {}) }
        selected.publications.set(destinationKey, publication)
        return { publication: structuredClone(publication), limitations }
      } catch (error) {
        // Scope/config/auth errors can also happen AFTER an accepted upload.
        // Only unambiguously pre-dispatch admission errors release this claim.
        if (/^MEMORY_(?:DISABLED|APPROVAL_REQUIRED|CONFIRM_REQUIRED|NATIVE_EXECUTION_REQUIRED|OPERATION_BUSY|CONFIG_BUSY)$/.test(error?.message ?? '')) { selected.publications.delete(destinationKey); throw error }
        return { publication: structuredClone(publication), limitations }
      }
    } finally { state.busy = false }
  } }
}
