/** Owned dsh child process with bounded startup and joined shutdown. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { hostEventSchema } from './protocol.ts'

/** Desktop deployment timeouts; validation belongs to the main-process environment parser. */
export interface HostOptions {
  executable: string; launcher: string; runtime: string; home: string; pnpm: string; startupMs: number; shutdownMs: number
}

/** One local management Host; closing it never cancels an accepted remote experiment. */
export class DesktopHost {
  private child: ChildProcess | undefined
  private stopping = false
  private stopPromise: Promise<void> | undefined
  private exitPromise: Promise<void> | undefined
  private diagnostic = ''

  /** @param options - resolved executable, runtime, profile and lifecycle limits. */
  constructor(private readonly options: HostOptions) {}

  /**
   * Launch the supported dsh profile and await private readiness.
   * @param failed - report an unexpected exit after readiness.
   * @returns the authenticated application URL.
   */
  start(failed: (error: Error) => void): Promise<string> {
    if (this.child !== undefined) throw new Error('Desktop Host was already started')
    const { executable, launcher, runtime, home, pnpm, startupMs } = this.options
    const child = spawn(executable, [launcher], {
      cwd: home, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, ASPERA_EXTENSION_ROOT: runtime,
        npm_execpath: pnpm, DSH_TELEMETRY_DISABLED: '1' },
    })
    this.child = child
    this.exitPromise = new Promise(resolveExit => { child.once('exit', () => { resolveExit() }); child.once('error', () => { resolveExit() }) })
    return new Promise((resolveReady, rejectReady) => {
      let ready = false; let settled = false
      const reject = (error: Error): void => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(error) } else if (ready && !this.stopping) failed(error) }
      const timer = setTimeout(() => { reject(new Error('Desktop Host startup timed out')) }, startupMs)
      child.stderr?.on('data', (bytes: Buffer) => { this.diagnostic = (this.diagnostic + bytes.toString()).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>').slice(-16_384) })
      child.on('message', (message: unknown) => {
        const event = hostEventSchema.safeParse(message)
        if (!event.success) { reject(new Error('Desktop Host sent an invalid private message')); return }
        if (event.data.type === 'aspera-desktop-fatal') { reject(new Error(event.data.detail)); return }
        if (!settled) { settled = true; ready = true; clearTimeout(timer); resolveReady(event.data.url) }
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => { reject(new Error(`Desktop Host exited (${code ?? signal})\n${this.diagnostic}`)) })
    })
  }

  /**
   * Request CLI disposal, await exit, and escalate only this owned child on timeout.
   * @returns completion after the local child has exited.
   */
  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.stopping = true
    return this.stopPromise = this.stopOwnedChild()
  }

  private async stopOwnedChild(): Promise<void> {
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null || this.exitPromise === undefined) return
    if (child.connected) child.send({ type: 'aspera-desktop-shutdown' }, error => { if (error !== null) child.kill('SIGTERM') })
    else child.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    const force = new Promise<void>((resolveForce, rejectForce) => {
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) { resolveForce(); return }
        if (process.platform === 'win32' && child.pid !== undefined) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => { if (error) rejectForce(error); else resolveForce() })
        else { child.kill('SIGKILL'); resolveForce() }
      }, this.options.shutdownMs)
    })
    try { await Promise.race([this.exitPromise, force]); await this.exitPromise }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
}
