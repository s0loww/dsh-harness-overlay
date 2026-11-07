import { existsSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const DIRECT_MARKERS = ['.mcp.json', '.dev.env', 'project-contours.json', '.git']
const ONEC_MARKERS = [
  'Configuration.xml',
  'ConfigurationExtension.xml',
  join('src', 'Configuration.mdo'),
  join('src', 'Configuration', 'Configuration.mdo'),
  join('Configuration', 'Configuration.mdo'),
  'DT-INF',
]

function hasMarker(root, marker) {
  try {
    const value = lstatSync(join(root, marker))
    return !value.isSymbolicLink()
  } catch { return false }
}

/**
 * Resolve the closest explicit project/configuration root without consulting
 * DSH state, MCP bindings, databases, or Oleg's project-preset canon.
 */
export function findSessionProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('ONEC_PROJECT_ROOT_ABSOLUTE_REQUIRED')
  const start = resolve(cwd)
  let current = start
  let onecRoot = null
  for (let depth = 0; depth < 32; depth += 1) {
    if (!existsSync(current)) break
    if (DIRECT_MARKERS.some(marker => hasMarker(current, marker))) return current
    if (onecRoot === null && ONEC_MARKERS.some(marker => hasMarker(current, marker))) onecRoot = current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return onecRoot ?? start
}
