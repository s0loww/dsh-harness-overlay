import { executeNativeTool } from './native-tools.js'
import { fileURLToPath } from 'node:url'
import { access, lstat } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { runNative } from './process.js'
import { safePath, boundedRead, sha } from './paths.js'
import { renderOptions } from './office-options.js'
export async function externalPath(url) {
  const packed = fileURLToPath(url), unpacked = packed.replace(/\.asar([\\/])/u, '.asar.unpacked$1')
  try { await access(unpacked); return unpacked } catch { await access(packed); return packed }
}
export async function runtimeFor(ctx, execution) {
  if (!execution?.agent) throw new Error('ACTIVE_AGENT_REQUIRED')
  const tool = ctx.tools.get('load_workspace_dependencies', execution.agent)
  if (!tool) throw new Error('DSH_BUNDLED_RUNTIME_REQUIRED')
  let runtime
  if (execution.token) {
    const result = await executeNativeTool(ctx,{ name: 'load_workspace_dependencies', agent: execution.agent, arguments: {}, parent: execution.token, callId: `${execution.callId}:office-runtime`, rootCallId: execution.rootCallId ?? execution.callId, signal: execution.signal })
    if (result.isError) throw new Error('DSH_BUNDLED_RUNTIME_REQUIRED')
    runtime = result.value
  } else {
    // Desktop's first-party tool prepares only the packaged local runtime; UI has no model execution token.
    runtime = await tool.execute({}, execution)
  }
  if (!runtime || typeof runtime.node !== 'string' || typeof runtime.python !== 'string') throw new Error('DSH_BUNDLED_RUNTIME_REQUIRED')
  for (const file of [runtime.node, runtime.python]) if (!(await lstat(file)).isFile()) throw new Error('DSH_BUNDLED_RUNTIME_REQUIRED')
  return runtime
}
export function createRuntime(ctx, resolveRuntime = exec => runtimeFor(ctx, exec)) {
  return {
    runtime: resolveRuntime,
    async convertDocument(path, scope, exec) {
      const runtime = await resolveRuntime(exec), worker = await externalPath(new URL('./convert-worker.js', import.meta.url))
      const result = await runNative(ctx, exec.agent, [runtime.node, worker, scope.root, path], { signal: exec.signal })
      return JSON.parse(result.stdout)
    },
    async office(scope, args, exec) {
      const runtime = await resolveRuntime(exec), cli = await externalPath(new URL('./lib/cli.js', import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json')))
      if (args.action === 'runtime') {
        const result = await runNative(ctx, exec.agent, [runtime.node, cli, 'capabilities', '--json'], { signal: exec.signal })
        return { ...runtime, office: JSON.parse(result.stdout), local: true, automaticDownload: false }
      }
      if (!scope.writable) throw new Error('WORKSPACE_WRITE_REQUIRED')
      if (!['convert', 'render', 'recalculate'].includes(args.action)) throw new Error('DOCUMENT_ACTION_REJECTED')
      const input = await safePath(scope.root, args.path), bytes = await boundedRead(input, 50 * 1024 * 1024), before = sha(bytes)
      if (!['.pdf', '.docx', '.xlsx', '.pptx', '.ods', '.odt', '.odp', '.csv'].includes(extname(input).toLowerCase())) throw new Error('DOCUMENT_FORMAT_UNSUPPORTED')
      const output = await safePath(scope.root, args.output, { missing: true })
      try { await lstat(output); throw new Error('DOCUMENT_OUTPUT_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
      // Parent must already exist: never create directories before native sandbox admission.
      await safePath(scope.root, dirname(output), { absolute: true, directory: true })
      if (args.action === 'convert' && !['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.odt', '.ods', '.odp'].includes(extname(output).toLowerCase())) throw new Error('DOCUMENT_FORMAT_UNSUPPORTED')
      if (args.action === 'recalculate' && (!['.xlsx', '.ods'].includes(extname(output).toLowerCase()) || !['.xlsx', '.ods'].includes(extname(input).toLowerCase()))) throw new Error('DOCUMENT_FORMAT_UNSUPPORTED')
      const argv = [runtime.node, cli, args.action, '--input', input, args.action === 'render' ? '--output-dir' : '--output', output]
      if (args.action === 'render') {
        argv.push(...renderOptions(args, extname(input).toLowerCase()))
      }
      if (args.action !== 'render' && args.sheet !== undefined) {
        if (args.action !== 'convert' || extname(output).toLowerCase() !== '.csv' || typeof args.sheet !== 'string' || !args.sheet.trim() || args.sheet.length > 100 || /[\0\r\n]/u.test(args.sheet)) throw new Error('DOCUMENT_SHEET_INVALID')
        argv.push('--sheet', args.sheet)
      }
      const result = await runNative(ctx, exec.agent, argv, { signal: exec.signal, writes: true })
      if (sha(await boundedRead(input, 50 * 1024 * 1024)) !== before) throw new Error('DOCUMENT_SOURCE_CHANGED')
      await safePath(scope.root, output, { absolute: true, directory: args.action === 'render' })
      return { ...JSON.parse(result.stdout), inputSha256: before, output: args.output, note: 'Inspect generated files; conversion is not visual acceptance.' }
    },
  }
}
