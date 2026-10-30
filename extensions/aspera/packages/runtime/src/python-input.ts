/** Account helpers receive their implementation and request independently of operating-system argv limits. */
import { shellQuote } from './transport.ts'

const loader = `import json,sys
payload=json.loads(sys.stdin.buffer.read().decode('utf-8'))
if type(payload) is not dict or set(payload)!={'program','request'} or type(payload['program']) is not str or type(payload['request']) is not dict:
 raise ValueError('Account helper input is incomplete or invalid')
scope={'__name__':'aspera_account_helper','__file__':'aspera-account-helper.py'}
exec(compile(payload['program'],'aspera-account-helper.py','exec'),scope)
print(json.dumps(scope['main'](payload['request']),ensure_ascii=False))`

/**
 * @param program - trusted helper definitions exposing main(request), without an automatic main invocation.
 * @param request - complete program-resolved settings and operation identity; credentials stay with the transport.
 * @returns fixed short Python argv and the UTF-8 input packet, consumed completely before execution.
 */
export function pythonMainInput(program: string, request: object): { command: string; input: string } {
  return { command: 'python3 -B -c ' + shellQuote(loader), input: JSON.stringify({ program, request }) }
}
