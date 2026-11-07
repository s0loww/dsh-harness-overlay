import { extname } from 'node:path'
import { extractDocument } from './engine-adapter.js'
import { safePath, boundedRead } from './paths.js'
try {
  const root = process.argv[2], input = await safePath(root, process.argv[3]), format = extname(input).slice(1).toLowerCase()
  if (!['docx', 'xlsx', 'pptx', 'pdf'].includes(format)) throw new Error('DOCUMENT_FORMAT_UNSUPPORTED')
  const outcome = await extractDocument(await boundedRead(input, 50 * 1024 * 1024), format)
  if (typeof outcome.markdown !== 'string' || Buffer.byteLength(outcome.markdown) > 8 * 1024 * 1024) throw new Error('DOCUMENT_TEXT_LIMIT')
  const pdf = outcome.pdf ? { pageCount: outcome.pdf.pageCount, kind: outcome.pdf.kind, pagesNeedingOcr: outcome.pdf.pagesNeedingOcr?.slice(0, 1000), ocrListTruncated: outcome.pdf.pagesNeedingOcr?.length > 1000 } : undefined
  process.stdout.write(JSON.stringify({ markdown: outcome.markdown, ...(pdf ? { pdf } : {}) }))
} catch (error) { process.stderr.write(({ scanned: 'DOCUMENT_OCR_REQUIRED', encrypted: 'DOCUMENT_ENCRYPTED', empty: 'DOCUMENT_EMPTY' })[error.code] ?? (/^[A-Z_]+$/u.test(error.message) ? error.message : 'DOCUMENT_CONVERSION_FAILED')); process.exitCode = 1 }

