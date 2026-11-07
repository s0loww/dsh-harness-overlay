import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOptions } from '../src/document-workbench/lib/office-options.js'

test('worksheet previews use geometry while document previews use bounded page numbers', () => {
  const worksheet = renderOptions({sheet:'Затраты',range:'a1:c4'}, '.xlsx')
  assert.ok(!worksheet.includes('--pages'))
  assert.deepEqual(worksheet.slice(-4), ['--sheet','Затраты','--range','A1:C4'])
  assert.ok(!renderOptions({}, '.ods').includes('--pages'))
  assert.equal(renderOptions({}, '.pdf').at(-1), '1')
  assert.equal(renderOptions({pages:'1,3'}, '.pptx').at(-1), '1,3')
  for (const [args, extension, code] of [
    [{pages:'1'}, '.xlsx', 'DOCUMENT_PAGE_RANGE_INVALID'],
    [{range:'A1:C4'}, '.xlsx', 'DOCUMENT_CELL_RANGE_INVALID'],
    [{sheet:'Sheet',range:'A1;whoami'}, '.xlsx', 'DOCUMENT_CELL_RANGE_INVALID'],
    [{sheet:'Sheet'}, '.pdf', 'DOCUMENT_SHEET_INVALID'],
    [{pages:'0'}, '.docx', 'DOCUMENT_PAGE_RANGE_INVALID'],
    [{pages:'1,2,3,4,5,6,7,8,9,10,11'}, '.pdf', 'DOCUMENT_PAGE_RANGE_INVALID'],
  ]) assert.throws(() => renderOptions(args,extension), new RegExp(code))
})
