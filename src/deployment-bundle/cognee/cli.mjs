import { createCogneeAdapter } from './adapter.mjs'
const [action, ...argv] = process.argv.slice(2)
const options = {}, names = { '--state-root': 'stateRoot', '--assets-root': 'assetsRoot', '--destination': 'destination', '--port': 'port', '--instance-id': 'instanceId', '--memory-gib': 'memoryGiB', '--owner-sid': 'ownerSid' }
try {
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--offline') { options.offline = true; continue }
    if (key === '--purge-data') { options.purgeData = true; continue }
    if (!names[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('COGNEE_CLI_ARGUMENT_INVALID')
    options[names[key]] = ['--port', '--memory-gib'].includes(key) ? Number(argv[++index]) : argv[++index]
  }
  const adapter = createCogneeAdapter(), methods = { detect: 'detect', export: 'exportOfflineAssets', install: 'install', start: 'start', health: 'health', stop: 'stop', uninstall: 'uninstall' }
  if (!methods[action]) throw new Error('COGNEE_CLI_ACTION_INVALID')
  console.log(JSON.stringify({ ok: true, ...await adapter[methods[action]](options) }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: /^COGNEE_[A-Z0-9_]+$/u.test(error.message ?? '') ? error.message : 'COGNEE_INSTALL_FAILED' }))
  process.exitCode = 1
}
