import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReleaseProbe, parseArguments } from './probe-specialized-release.mjs'
import { projectBindingsAcceptance } from './probe-project-bindings-release.mjs'

/** Installed-byte native acceptance, isolated candidate state only. No browser,
 * model, external connection, project runner, memory publication or deployment. */
export async function companionsAcceptance(input) {
  await projectBindingsAcceptance(input)
  const { ctx, check, report, installed, agents } = input
  for (const [id, name] of [['airules-live2d-companion', 'airules-dsh-live2d-companion'], ['airules-captain-companion', 'airules-dsh-captain-companion']]) {
    const rows = [...ctx.loader.entries()].filter(row => row.options?.id === id && row.options?.name === name)
    check(`${id} is mounted once as an active native host`, rows.length === 1 && rows[0].fiber?.state === 2)
  }
  const origin = ctx.webServer.getOrigin(), login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ')
  check('companions exchange the real native loopback admission cookie', login.status === 303 && !!cookie)
  async function raw(path, { body, token, authenticated = true, method, signal } = {}) {
    return fetch(new URL(path, origin), { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { origin: new URL(origin).origin, ...(authenticated ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-airules-csrf': token ?? '' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) })
  }
  async function request(path, options) {
    const response = await raw(path, options)
    let value; try { value = await response.json() } catch { value = { ok: false } }
    return { status: response.status, ...value }
  }

  const live = '/airules/live2d/configuration', captain = '/airules/captain-companion'
  for (const endpoint of [live, captain]) {
    check(`${endpoint} rejects unadmitted requests`, (await request(endpoint, { authenticated: false })).status === 403)
    check(`${endpoint} refuses unsupported HTTP methods`, (await request(endpoint, { method: 'DELETE' })).status === 405)
  }
  let config = await request(live)
  check('Live2D is opt-in and exposes local model choices', config.ok && config.config?.enabled === false && config.models?.includes('Miara') && config.models?.includes('Hiyori') && typeof config.csrfToken === 'string')
  const originalLive = { ...config.config }, liveRevision = config.revision
  const changedLive = { ...originalLive, enabled: true, model: 'Hiyori', height: 240, phrases: { Miara: { working: ['Synthetic Miara fixture.'] }, Hiyori: { working: ['Synthetic Hiyori fixture.'] } } }
  check('Live2D settings mutation retains native CSRF', (await request(live, { body: { config: changedLive, expectedRevision: config.revision } })).status === 403)
  const savedLive = await request(live, { token: config.csrfToken, body: { config: changedLive, expectedRevision: config.revision } })
  check('Live2D configuration saves its exact validated settings', savedLive.ok && savedLive.config?.enabled === true && savedLive.config?.model === 'Hiyori' && savedLive.config?.height === 240 && /^[a-f0-9]{64}$/u.test(savedLive.revision ?? ''))
  const roundtripLive = await request(live)
  check('Live2D custom phrases persist independently for each character', roundtripLive.config?.phrases?.Miara?.working?.[0] === 'Synthetic Miara fixture.' && roundtripLive.config?.phrases?.Hiyori?.working?.[0] === 'Synthetic Hiyori fixture.' && !Object.hasOwn(roundtripLive.config.phrases.Miara, 'idle') && !Object.hasOwn(roundtripLive.config.phrases.Hiyori, 'idle'))
  check('Live2D custom phrases preserve the built-in fallback catalogue for both characters', config.phraseCatalog?.Miara?.idle?.length > 0 && config.phraseCatalog?.Hiyori?.idle?.length > 0 && JSON.stringify(roundtripLive.phraseCatalog) === JSON.stringify(config.phraseCatalog))
  for (const [kind, phrases] of [
    ['too many lines', { Miara: { working: Array(13).fill('Synthetic fixture.') } }],
    ['embedded newline', { Miara: { working: ['Synthetic\nfixture.'] } }],
    ['UTF-8 byte budget', { Miara: Object.fromEntries(['idle','working','waiting','complete','error','stopped'].map(phase => [phase, Array(12).fill('я'.repeat(240))])) }],
  ]) check(`Live2D rejects invalid custom phrases: ${kind}`, (await request(live, { token: config.csrfToken, body: { config: { ...changedLive, phrases }, expectedRevision: savedLive.revision } })).status === 400)
  check('Live2D settings reject a stale revision before mutation', (await request(live, { token: config.csrfToken, body: { config: originalLive, expectedRevision: liveRevision } })).status === 409)
  check('Live2D does not accept arbitrary model paths', (await request(live, { token: config.csrfToken, body: { config: { ...changedLive, model: '../../private' }, expectedRevision: savedLive.revision } })).status === 400)
  check('Live2D invalid and stale writes preserve the selected configuration', JSON.stringify((await request(live)).config) === JSON.stringify(savedLive.config))
  const restoredLive = await request(live, { token: config.csrfToken, body: { config: originalLive, expectedRevision: savedLive.revision } })
  check('Live2D fixture preferences restore to disabled before visible startup', restoredLive.ok && restoredLive.config?.enabled === false)

  const assets = [
    ['vendor/pixi.min.js', 'application/javascript'],
    ['vendor/live2dcubismcore.min.js', 'application/javascript'],
    ['vendor/cubism4.min.js', 'application/javascript'],
    ['model/Miara/miara_pro_t03.model3.json', 'application/json'],
    ['model/Miara/miara_pro_t03.moc3', 'application/octet-stream'],
    ['model/Miara/miara_pro_t03.4096/texture_00.png', 'image/png'],
    ['model/Hiyori/hiyori_pro_t11.model3.json', 'application/json'],
    ['model/Hiyori/hiyori_pro_t11.moc3', 'application/octet-stream'],
  ]
  check('Live2D local assets also require native admission', (await raw('/airules/live2d/assets/' + assets[0][0], { authenticated: false })).status === 403)
  for (const [path, mime] of assets) {
    const response = await raw('/airules/live2d/assets/' + path), bytes = Buffer.from(await response.arrayBuffer())
    const expected = await readFile(join(installed, 'airules-dsh-live2d-companion/assets', path))
    check(`Live2D serves exact installed ${path} bytes with its declared MIME`, response.status === 200 && response.headers.get('content-type')?.startsWith(mime) && response.headers.get('x-content-type-options') === 'nosniff' && expected.equals(bytes))
  }
  for (const path of ['vendor/%2e%2e%2f%2e%2e%2fpackage.json', 'vendor/%5c..%5cpackage.json', 'vendor/file:private', 'private/settings.json']) {
    const response = await raw('/airules/live2d/assets/' + path)
    check(`Live2D asset route refuses an unsupported path ${path}`, response.status >= 400 && response.status < 500)
    await response.arrayBuffer()
  }
  const abort = new AbortController(), sessionId = agents.find(row => row.preset === '1c-airules').id
  try {
    const response = await raw('/airules/live2d/events?sessionId=' + encodeURIComponent(sessionId), { signal: abort.signal }), reader = response.body.getReader(), first = await reader.read()
    const text = new TextDecoder().decode(first.value), payload = JSON.parse(text.split('data: ')[1].split('\n')[0])
    check('Live2D native event stream exposes only a sanitized phase', response.status === 200 && response.headers.get('content-type')?.startsWith('text/event-stream') && Object.keys(payload).length === 1 && payload.phase === 'idle')
    await reader.cancel()
  } finally { abort.abort() }

  config = await request(captain)
  check('Captain exposes local automatic speech preferences with a native CSRF token', config.ok && config.config?.schemaVersion === 1 && config.config?.enabled === true && config.config?.automatic === true && typeof config.csrfToken === 'string')
  const originalCaptain = { ...config.config }, captainRevision = config.revision, changedCaptain = { ...originalCaptain, intervalSeconds: 240, automatic: false, phrases: { idle: ['Synthetic Captain fixture.'] } }
  check('Captain settings retain native CSRF', (await request(captain, { body: { config: changedCaptain, revision: captainRevision } })).status === 403)
  const savedCaptain = await request(captain, { token: config.csrfToken, body: { config: changedCaptain, revision: captainRevision } })
  check('Captain exact configuration saves with a new revision', savedCaptain.ok && savedCaptain.config?.automatic === false && savedCaptain.config?.intervalSeconds === 240 && /^[a-f0-9]{64}$/u.test(savedCaptain.revision ?? ''))
  const roundtripCaptain = await request(captain)
  check('Captain custom phrase persists without overriding other themes', roundtripCaptain.config?.phrases?.idle?.[0] === 'Synthetic Captain fixture.' && !Object.hasOwn(roundtripCaptain.config.phrases, 'tests') && !Object.hasOwn(roundtripCaptain.config.phrases, 'error'))
  for (const [kind, phrases] of [
    ['too many lines', { idle: Array(13).fill('Synthetic fixture.') }],
    ['embedded newline', { idle: ['Synthetic\nfixture.'] }],
    ['UTF-8 byte budget', Object.fromEntries(['idle','start','completion','error','approval','tests','context','memory'].map(phase => [phase, Array(12).fill('я'.repeat(240))]))],
  ]) check(`Captain rejects invalid custom phrases: ${kind}`, (await request(captain, { token: config.csrfToken, body: { config: { ...changedCaptain, phrases }, revision: savedCaptain.revision } })).status === 400)
  check('Captain rejects stale configuration revisions', (await request(captain, { token: config.csrfToken, body: { config: originalCaptain, revision: captainRevision } })).status === 409)
  check('Captain rejects excessive notification frequency', (await request(captain, { token: config.csrfToken, body: { config: { ...changedCaptain, intervalSeconds: 1 }, revision: savedCaptain.revision } })).status === 400)
  check('Captain invalid and stale writes preserve its saved configuration', JSON.stringify((await request(captain)).config) === JSON.stringify(savedCaptain.config))
  const restoredCaptain = await request(captain, { token: config.csrfToken, body: { config: originalCaptain, revision: savedCaptain.revision } })
  check('Captain fixture preferences restore to their original values', restoredCaptain.ok && JSON.stringify(restoredCaptain.config) === JSON.stringify(originalCaptain))
  report.companions = { localLive2dAssetsChecked: assets.length, models: restoredLive.models, nativeAdmissionAndCsrf: true, settingsCas: true, captainSpeech: 'local-curated', paidModelRequests: 0, realDeployments: 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runReleaseProbe({ ...parseArguments(process.argv.slice(2)), extraAcceptance: companionsAcceptance }))); process.exit(0) }
  catch (error) { console.error(JSON.stringify({ status: 'FAIL', code: error.message, reportPath: error.reportPath ?? null })); process.exit(1) }
}
