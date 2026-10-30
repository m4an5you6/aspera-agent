/** Account-owned controller helpers receive complete requests independently of command-line limits. */
import { readFileSync } from 'node:fs'
import type { FleetDriver } from './fleet.ts'
import type { DeploymentConfig } from './deploy.ts'
import { shellQuote } from './transport.ts'

const program = readFileSync(new URL('../scripts/controller-recovery.py', import.meta.url), 'utf8')
const loader = `import json,sys
payload=json.loads(sys.stdin.buffer.read().decode('utf-8'))
sys.argv=['controller-recovery.py',json.dumps(payload['request'],ensure_ascii=False)]
exec(compile(payload['program'],'controller-recovery.py','exec'),{'__name__':'__main__'})`

/**
 * @param driver - selected account's authenticated transport.
 * @param target - program-owned SSH and control directory settings.
 * @param request - complete original authorization and operation request.
 * @param signal - shared operation lifetime.
 * @param password - private operation-scoped credential.
 * @returns parsed helper output after confirmed command exit; failures retain operation and transfer context.
 */
export async function runControllerScript(driver: Pick<FleetDriver, 'remote'>, target: DeploymentConfig,
  request: { mode: string; operationId?: string }, signal: AbortSignal, password?: string): Promise<unknown> {
  const input = JSON.stringify({ program, request })
  const context = `bytes=${Buffer.byteLength(input)}, operation=${request.operationId ?? 'read-only'}`
  let output: string
  try {
    output = await driver.remote(target, `python3 -B -c ${shellQuote(loader)}`, signal, password, input)
  } catch (error) {
    throw new Error(`Controller helper ${request.mode} input or execution failed (${context}): ${String(error)}`, { cause: error })
  }
  try { return JSON.parse(output) }
  catch (error) { throw new Error(`Controller helper ${request.mode} response is invalid JSON (${context})`, { cause: error }) }
}
