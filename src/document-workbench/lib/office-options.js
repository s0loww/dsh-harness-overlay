export function renderOptions(args, extension) {
  const worksheet = ['.xlsx', '.ods', '.csv'].includes(extension)
  const result = ['--max-pages', '10', '--dpi', '96', '--max-pixels', '16777216']
  if (worksheet) {
    if (args.pages !== undefined) throw new Error('DOCUMENT_PAGE_RANGE_INVALID')
    if (args.sheet !== undefined) {
      if (typeof args.sheet !== 'string' || !args.sheet.trim() || args.sheet.length > 100 || /[\0\r\n]/u.test(args.sheet)) throw new Error('DOCUMENT_SHEET_INVALID')
      result.push('--sheet', args.sheet)
    }
    if (args.range !== undefined) {
      if (!args.sheet || typeof args.range !== 'string' || !/^[A-Za-z]{1,3}[1-9]\d{0,6}(?::[A-Za-z]{1,3}[1-9]\d{0,6})?$/u.test(args.range)) throw new Error('DOCUMENT_CELL_RANGE_INVALID')
      result.push('--range', args.range.toUpperCase())
    }
  } else {
    if (args.sheet !== undefined || args.range !== undefined) throw new Error('DOCUMENT_SHEET_INVALID')
    const pages = args.pages ?? '1'
    if (typeof pages !== 'string' || !/^[1-9]\d{0,3}(?:,[1-9]\d{0,3}){0,9}$/u.test(pages)) throw new Error('DOCUMENT_PAGE_RANGE_INVALID')
    result.push('--pages', pages)
  }
  return result
}
