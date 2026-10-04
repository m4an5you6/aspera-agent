/** Captured command outcomes preserve diagnostics independently of cancellation and exit status. */
export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
}

/** An SSH disconnect does not establish that a remote command has stopped. */
export interface RemoteCommandResult extends CommandResult {
  exitConfirmed: boolean
}

/** Failed checked command with its complete bounded diagnostics. */
export class RemoteCommandError extends Error {
  constructor(readonly result: RemoteCommandResult) {
    super(`Remote command ${result.timedOut ? 'timed out' : result.cancelled ? 'was cancelled' : `exited ${result.exitCode}`}: ${result.stderr || result.stdout}`)
    this.name = result.timedOut ? 'TimeoutError' : result.cancelled ? 'AbortError' : 'RemoteCommandError'
  }
}

/** SSH failed before a complete remote exit receipt could be observed. */
export class SshConnectionError extends RemoteCommandError {
  constructor(result: RemoteCommandResult) {
    super(result)
    this.name = 'SshConnectionError'
    this.message = `SSH connection or command channel failed: ${result.stderr || result.stdout}`
  }
}
