/** Large program/request bytes stay out of the remote shell command. */
import { expect, it } from 'vitest'
import { pythonMainInput } from '../src/python-input.ts'

it('keeps argv fixed while retaining complete Unicode, quotes and newlines in the input packet', () => {
  const small = pythonMainInput('def main(request): return request', {})
  const program = '# comment\n'.repeat(100000) + 'def main(request): return request'
  const request = { operationId: 'original-operation', text: '中文\n"quoted"\\literal'.repeat(100000) }
  const large = pythonMainInput(program, request)
  expect(large.command).toBe(small.command)
  expect(Buffer.byteLength(large.command)).toBeLessThan(4096)
  expect(JSON.parse(large.input)).toEqual({ program, request })
  expect(large.command).not.toContain(request.operationId)
  expect(large.command).toContain('sys.stdin.buffer.read()')
  expect(large.command.indexOf('json.loads')).toBeLessThan(large.command.indexOf('exec(compile'))
})
