// Parser-only adapter. Provenance and MIT permission: ../NOTICE.
import { toMarkdownBytes } from '@firecrawl/anydoc'
import { Worker } from 'node:worker_threads'
const KINDS = { TextBased: 'text', Scanned: 'scanned', ImageBased: 'image', Mixed: 'mixed' }
export async function extractDocument(bytes, format) {
  if (format !== 'pdf') return { markdown: await toMarkdownBytes(bytes, format) }
  const raw = await new Promise((resolve, reject) => {
    // Resolve metadata only: importing the plugin entry would require DSH services in standalone Node.
    const worker = new Worker(new URL('./lib/pdf-worker.js', import.meta.resolve('@jiaoqsh/dsh-document/package.json')), { workerData: { bytes } })
    let settled = false
    const finish = (error, result) => { if (settled) return; settled = true; worker.terminate().catch(() => {}); error ? reject(error) : resolve(result) }
    worker.once('message', reply => reply.ok ? finish(null, reply.result) : finish(new Error('DOCUMENT_CONVERSION_FAILED')))
    worker.once('error', () => finish(new Error('DOCUMENT_CONVERSION_FAILED')))
    worker.once('exit', () => finish(new Error('DOCUMENT_CONVERSION_FAILED')))
  })
  const kind = KINDS[raw.pdfType]
  if (!raw.markdown?.trim()) throw new Error(kind === 'scanned' || kind === 'image' || raw.pagesNeedingOcr?.length ? 'DOCUMENT_OCR_REQUIRED' : 'DOCUMENT_EMPTY')
  return { markdown: raw.markdown, pdf: { pageCount: raw.pageCount, kind, pagesNeedingOcr: raw.pagesNeedingOcr ?? [] } }
}
