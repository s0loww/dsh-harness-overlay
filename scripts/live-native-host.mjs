import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadSubscriptionPlugin } from './probe-live-model-orchestration.mjs'
import { assertCandidatePath, preflightCandidate } from './smoke-official-candidate.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const NATIVE = join(REPO, 'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai')
const native = name => import(pathToFileURL(join(NATIVE, name, 'lib/index.js')))

/** Isolated native host. Booting never submits a model prompt. No auth file is copied. */
export async function bootNativeHost({ candidateRoot, runRoot, authStorePath, credentialsPath,
  provider, model, effort, guard, mcpConfig, onEvent = () => {}, maxRequests = 24,
  policyArtifactRoot=join(REPO,'dist/airules-official-policy-0.12.0-dev39'),uiArtifactRoot=join(REPO,'dist/airules-ui-overlay-0.1.0-dev16') }) {
  if (![candidateRoot, runRoot, authStorePath, credentialsPath].every(isAbsolute) || typeof guard !== 'function') throw new Error('EXPLICIT_LIVE_HOST_BOUNDARIES_REQUIRED')
  candidateRoot = assertCandidatePath(candidateRoot)
  if (!((provider === 'codex' && model === 'gpt-6.1-sol' && effort === 'medium') ||
    (provider === 'deepseek-account' && model === 'deepseek-flash' && effort === 'high'))) throw new Error('AUTHORIZED_LIVE_ROUTE_REQUIRED')
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 24) throw new Error('BOUNDED_REQUEST_BUDGET_REQUIRED')
  if (resolve(process.env.DSH_HOME ?? '') !== resolve(join(candidateRoot, 'home')) ||
    resolve(process.env.DSH_AGENTS_HOME ?? '') !== resolve(join(candidateRoot, 'home-agents'))) throw new Error('SET_ISOLATED_HOME_BEFORE_NATIVE_IMPORTS')
  await preflightCandidate({ candidateRoot,
    uiArtifactRoot, policyArtifactRoot })
  await mkdir(runRoot, { recursive: true })
  const patch = join(runRoot, 'live-host.patch.yml')
  const disabled = ['airules-subscriptions', 'airules-telegram', 'airules-mobile', 'airules-mcp-manager',
    'airules-acp', 'airules-acp-adapter', 'airules-additional-providers', 'session-title-llm',
    'session-telemetry-otel', 'desktop-product-telemetry', 'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'llm-retry']
  await writeFile(patch, disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') +
    `- id: credentials\n  config:\n    path: ${JSON.stringify(credentialsPath)}\n    watch: false\n` +
    `- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: ${JSON.stringify(runRoot)}\n` +
    '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
  const { runProfile } = await import(pathToFileURL(join(NATIVE, 'dsh/lib/profile-boot.js')))
  const { loadLayeredEnv } = await native('dsh-app-boot')
  const { setSandboxMode } = await native('dsh-sandbox-policy')
  const { installModelSelection } = await native('dsh-agent')
  const { createUserMessage } = await native('dsh-llm')
  let app, agent, requests = 0
  const handles = []
  try {
    app = await runProfile({ profile: 'desktop', environment: loadLayeredEnv('dsh', candidateRoot), patchFiles: [patch], args: [] })
    const ctx = app.ctx
    const runtimeProof=await verifyFsCompat(ctx,{candidateRoot,policyArtifactRoot})
    // A mandatory deny guard is additional to the actual native sandbox.
    ctx.tools.guard(guard)
    ctx.on('session/event', (session, event) => onEvent('session/event', { sessionId: session.id, event }), { global: true })
    ctx.on('agent/created', ({ agent: child }) => {
      const policy = ctx.sandboxPolicy.resolve({ session: child.session })
      if (policy.mode !== 'workspace-write' || resolve(policy.workspaceRoot) !== resolve(runRoot)) throw new Error('NATIVE_CHILD_POLICY_DRIFT')
      onEvent('agent/created', { agentId: child.id, options: child.options, policy, parentSession: child.session.header.parentSession })
      child.ctx.on('agent/request', async (payload, next) => {
        // Scope routing also admits descendant events to ancestor listeners.
        // agentEvents injects the exact subject in addition to turn/step/signal.
        if (payload.agent !== child) return next()
        const resolved = await next()
        if (resolved.provider !== provider || resolved.model !== model || resolved.reasoningEffort !== effort) throw new Error('LIVE_ROUTE_DRIFT')
        if (++requests > maxRequests) throw new Error('LIVE_MODEL_REQUEST_BUDGET_EXCEEDED')
        onEvent('request', { agentId: child.id, provider, model, effort, requestNumber: requests })
        return { ...resolved, maxTokens: 4096 }
      }, { prepend: true })
    }, { global: true })
    for (const kind of ['subagent/start', 'subagent/end']) ctx.on(kind, event => onEvent(kind, {
      runId: event.runId, provider: event.provider, id: event.id, local: event.local,
      ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
    }), { global: true })
    ctx.on('tools/result', (exec, result) => onEvent('tools/result', {
      agentId: exec.agent?.id, name: exec.name, callId: exec.callId, isError: result.isError,
    }), { global: true })
    ctx.on('agent/error', ({ agent: subject }) => onEvent('agent/error', { agentId: subject.id }), { global: true })
    const mount = async (plugin, config) => { const h = ctx.plugin(plugin, config); handles.push(h); await h.await(); return h }
    await mount(await native('dsh-llm-deepseek-account'), {})
    const subscription = await loadSubscriptionPlugin(join(runRoot, 'host-runtime'),undefined,policyArtifactRoot)
    await mount({ name: 'acceptance-explicit-subscriptions', inject: ['llm'], apply(scope) {
      return subscription.apply(scope, { providers: ['codex'], pool: { enabled: false },
        rateLimit: { wait: false, maxWaitMs: 1 } }, { authStorePath })
    } })
    if (mcpConfig) {
      if (mcpConfig.serverName !== '1C-docs-mcp' || mcpConfig.transport !== 'streamable-http') throw new Error('ONLY_APPROVED_DIRECT_DOCS_MCP')
      await mount(await native('dsh-mcp-client'), { ...mcpConfig, failOnStartupError: true, toolCallTimeoutMs: 30000 })
    }
    const route = { provider, model, reasoningEffort: effort, maxTokens: 4096 }
    const handle = await ctx.agents.create({ sessionId: `live-acceptance-${randomUUID()}`,
      meta: { cwd: runRoot, agentPreset: '1c-airules' }, agentOptions: route,
      setup: async (scope, created) => {
        setSandboxMode(created.session, 'workspace-write')
        installModelSelection(scope, { current: route, assembled: undefined })
        await ctx.agentPresets.select(created, '1c-airules')
      } })
    agent = handle.agent ?? ctx.agents.get(handle.id)
    if (!agent || !agent.ctx.tools.get('airules_delegate', agent)) throw new Error('NATIVE_DELEGATION_REQUIRED')
    return { ctx, agent, runtimeProof, get requests() { return requests },
      async run(prompt) {
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('BOUNDED_PROMPT_REQUIRED')
        agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
        let timer
        try {
          await Promise.race([(async () => {
            // Same drain contract as native dsh-headless: children may wake the parent.
            while (true) {
              await agent.whenIdle()
              const seq = agent.session.seq
              if (!await ctx.subagents?.waitForChildren(agent) && agent.status === 'idle' && seq === agent.session.seq) break
            }
            await ctx.sessions.flush(agent.session)
          })(), new Promise((_, reject) => { timer = setTimeout(() => {
            agent.cancel({ kind: 'user' }); void app.ctx.fiber.dispose()
            reject(new Error('LIVE_RUN_TIMEOUT'))
          }, 600000) })])
        } finally { clearTimeout(timer) }
      },
      async dispose() { agent.cancel({ kind: 'user' }); await app.ctx.fiber.dispose() },
    }
  } catch (error) {
    for (const h of handles.reverse()) await h.dispose().catch(() => {})
    await app?.ctx?.fiber.dispose().catch(() => {})
    throw error
  }
}

/** Attest the profile-resolved service, never replace or monkeypatch native fs. */
export async function verifyFsCompat(ctx,{candidateRoot,policyArtifactRoot}) {
  const relative='airules-dsh-native-fs/lib'
  const directory=join(candidateRoot,'home/profiles/desktop/node_modules',relative)
  const payloadDirectory=join(policyArtifactRoot,'payload/packages',relative)
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
  const hashes={}
  for(const filename of ['index.js','local.js']) {
    const [loaded,expected]=await Promise.all([readFile(join(directory,filename)),readFile(join(payloadDirectory,filename))])
    if(sha(loaded)!==sha(expected))throw new Error('FS_COMPAT_MODULE_HASH_MISMATCH')
    hashes[filename]=sha(loaded)
  }
  const [implementation,local]=await Promise.all([import(pathToFileURL(join(directory,'index.js'))),import(pathToFileURL(join(directory,'local.js')))])
  const exposed=ctx.get('fs')
  // Cordis publicly exposes the underlying service through its original symbol.
  const filesystem=exposed?.[Symbol.for('cordis.original')]??exposed
  if(typeof implementation.SandboxedFileSystem!=='function'||filesystem?.constructor!==implementation.SandboxedFileSystem||typeof local.LocalFileSystem!=='function'||!(filesystem instanceof local.LocalFileSystem)||Object.getPrototypeOf(implementation.SandboxedFileSystem.prototype)!==local.LocalFileSystem.prototype)throw Object.assign(new Error('FS_COMPAT_NATIVE_SANDBOX_SERVICE_NOT_LOADED'),{proofDebug:{actualConstructor:filesystem?.constructor?.name,actualLocalEditHasBom:String(Object.getPrototypeOf(Object.getPrototypeOf(filesystem??{}))?.editText).includes('original.utf8Bom'),actualLocalEditSha:sha(Buffer.from(String(Object.getPrototypeOf(Object.getPrototypeOf(filesystem??{}))?.editText))),expectedLocalEditSha:sha(Buffer.from(String(local.LocalFileSystem.prototype.editText))),ownerPlugin:filesystem?.ctx?.fiber?.entry?.options?.name,ownerId:filesystem?.ctx?.fiber?.entry?.options?.id,constructorMatches:filesystem?.constructor===implementation.SandboxedFileSystem,localInstance:typeof local.LocalFileSystem==='function'&&filesystem instanceof local.LocalFileSystem,expectedSuperclassMatches:Object.getPrototypeOf(implementation.SandboxedFileSystem.prototype)===local.LocalFileSystem.prototype,actualSuperclass:Object.getPrototypeOf(Object.getPrototypeOf(filesystem??{}))?.constructor?.name}})
  return {filesystem:{package:'airules-dsh-native-fs',hashes,profileEntryId:filesystem?.ctx?.fiber?.entry?.options?.id,profileEntryName:filesystem?.ctx?.fiber?.entry?.options?.name,profileServiceIdentity:true,nativeSandboxSubclass:true,patchedLocalSuperclass:true},policyArtifact:policyArtifactRoot.split(/[\\/]/).at(-1)}
}
