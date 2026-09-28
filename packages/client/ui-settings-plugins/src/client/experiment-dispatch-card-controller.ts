/** Settings form and saved experiment records for Web dispatch. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ExperimentDispatchEntry, ExperimentSshAccount } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, numberField, stringListField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Host settings namespace owned by experiment dispatch. */
export const EXPERIMENT_DISPATCH_NS = 'experiment-dispatch'
const DEFAULT_TOKEN_REF = 'DSH_EXPERIMENT_TOKEN'
const TOKEN_FIELD = 'receiverToken'

/** Editable deployment target values. */
export interface ExperimentDispatchSettings {
  host?: string
  sshPort?: number
  username?: string
  authMode?: 'key' | 'password'
  passwordRef?: string
  remotePort?: number
  remoteRoot?: string
  localRepo?: string
  identityFile?: string
  dataRoots?: string[]
  tokenRef?: string
  agentCredentialRefs?: string[]
  toolTimeoutMs?: number
}

/** The experiment configuration fields shown in the card. */
export const experimentFields = [
  'host', 'username', 'authMode', 'sshPort', 'remotePort', 'remoteRoot', 'localRepo', 'identityFile',
  'dataRoots', 'tokenRef', 'agentCredentialRefs', 'toolTimeoutMs',
] as const

/** One card snapshot, including persisted receiver records. */
export interface ExperimentDispatchCardState extends CardShell {
  fields: Record<(typeof experimentFields)[number], CardFieldState>
  receiverToken: CardFieldState
  receiverTokenConfigured: boolean
  receiverTokenWritable: boolean
  sshPassword: CardFieldState
  sshPasswordConfigured: boolean
  sshPasswordWritable: boolean
  records: readonly ExperimentDispatchEntry[]
  loading: boolean
  loaded: boolean
  busyId?: string
  recordError?: string
}

/** The slot's browser-facing state and actions. */
export interface ExperimentDispatchCardFace extends CardActions {
  hooks: { experimentDispatchCard: SnapshotStore<ExperimentDispatchCardState> }
  loadRecords: () => void
  refreshRecord: (submissionId: string) => void
  cancelRecord: (submissionId: string) => void
}

/** Bridges the settings namespace and dispatch Remote to one card. */
export class ExperimentDispatchCardController {
  private readonly form: CardForm<ExperimentDispatchSettings>
  private readonly store: SnapshotStore<ExperimentDispatchCardState>
  private records: readonly ExperimentDispatchEntry[] = []
  private loading = false
  private loaded = false
  private busyId: string | undefined
  private recordError: string | undefined
  private credential = { ref: '', configured: false, writable: true }
  private password = { configured: false, writable: true }
  private passwordRead = 0

  /**
   * @param scope - the deployment's experiment dispatch settings scope.
   * @param ctx - browser context carrying the dispatch Remote.
   */
  constructor(private readonly scope: SettingsScope<ExperimentDispatchSettings>, private readonly ctx: ClientContext) {
    this.form = new CardForm(scope, [
      textField('host'), textField('username'), textField('authMode'), numberField('sshPort'), numberField('remotePort'), textField('remoteRoot'),
      textField('localRepo'), textField('identityFile'), stringListField('dataRoots'),
      textField('tokenRef'), stringListField('agentCredentialRefs'), numberField('toolTimeoutMs'),
    ], [
      { field: TOKEN_FIELD, write: text => this.writeToken(text) },
      { field: 'sshPassword', preserveWhitespace: true, write: text => this.writePassword(text) },
    ])
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.readCredential(); void this.readPassword() })
    void this.readCredential()
    void this.readPassword()
  }

  private projection(): ExperimentDispatchCardState {
    return {
      ...this.form.shell(),
      fields: Object.fromEntries(experimentFields.map(field => [field, this.form.field(field)])) as ExperimentDispatchCardState['fields'],
      receiverToken: this.form.field(TOKEN_FIELD),
      receiverTokenConfigured: this.credential.configured,
      receiverTokenWritable: this.credential.writable,
      sshPassword: this.form.field('sshPassword'),
      sshPasswordConfigured: this.password.configured,
      sshPasswordWritable: this.password.writable,
      records: this.records,
      loading: this.loading,
      loaded: this.loaded,
      ...this.busyId === undefined ? {} : { busyId: this.busyId },
      ...this.recordError === undefined ? {} : { recordError: this.recordError },
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private tokenRef(): string {
    return this.scope.getSnapshot().value?.tokenRef || DEFAULT_TOKEN_REF
  }

  private async readCredential(): Promise<void> {
    const ref = this.tokenRef()
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.publish()
    }
    const result = await this.ctx.remote.credentials.describe([ref])
    if (!result.ok || ref !== this.tokenRef()) return
    const view = result.value[ref]
    this.credential = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true }
    this.publish()
  }

  /**
   * Re-read the receiver token after another page changes its reference.
   * @param ref - credential reference reported by the Host.
   */
  refreshCredential(ref: string): void {
    if (ref === this.credential.ref) void this.readCredential()
  }

  private async writeToken(value: string): Promise<boolean> {
    const result = await this.ctx.remote.credentials.set(this.tokenRef(), value)
    if (!result.ok) return false
    await this.readCredential()
    return this.credential.configured
  }

  private account(draft: boolean): ExperimentSshAccount | undefined {
    const saved = this.scope.getSnapshot().value
    const host = draft ? this.form.field('host').text.trim() : saved?.host ?? ''
    const username = draft ? this.form.field('username').text.trim() : saved?.username ?? ''
    const sshPort = draft ? Number(this.form.field('sshPort').text || 22) : saved?.sshPort ?? 22
    if (host === '' || username === '' || !Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65535) return undefined
    return { host, username, sshPort, ...(saved?.passwordRef === undefined ? {} : { passwordRef: saved.passwordRef }) }
  }

  private async readPassword(): Promise<void> {
    const generation = ++this.passwordRead
    const account = this.account(true)
    this.password = { configured: false, writable: true }
    this.publish()
    if (account === undefined) return
    const result = await this.ctx.remote.experimentDispatch.passwordStatus(account)
    if (!result.ok || generation !== this.passwordRead) return
    this.password = result.value
    this.publish()
  }

  private async writePassword(value: string): Promise<boolean> {
    const account = this.account(false)
    if (account === undefined || this.scope.getSnapshot().value?.authMode !== 'password') return false
    const result = await this.ctx.remote.experimentDispatch.setPassword(account, value)
    if (!result.ok) return false
    await this.readPassword()
    return true
  }

  /** Load locally saved experiments. */
  async loadRecords(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.recordError = undefined
    this.publish()
    try {
      const result = await this.ctx.remote.experimentDispatch.list()
      if (result.ok) {
        this.records = result.value
        this.loaded = true
      } else this.recordError = result.error.message
    } catch (error: unknown) {
      this.recordError = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
      this.publish()
    }
  }

  private async changeRecord(submissionId: string, action: 'refresh' | 'cancel'): Promise<void> {
    if (this.busyId !== undefined) return
    this.busyId = submissionId
    this.recordError = undefined
    this.publish()
    try {
      const result = await this.ctx.remote.experimentDispatch[action](submissionId)
      if (result.ok) {
        this.records = this.records.map(entry => entry.submissionId === submissionId
          ? { ...entry, latest: result.value } : entry)
      } else this.recordError = result.error.message
    } catch (error: unknown) {
      this.recordError = error instanceof Error ? error.message : String(error)
    } finally {
      this.busyId = undefined
      this.publish()
    }
  }

  /**
   * Build the slot's form and experiment actions.
   * @returns The card snapshot and its actions.
   */
  inject(): ExperimentDispatchCardFace {
    const actions = this.form.actions()
    return {
      hooks: { experimentDispatchCard: this.store },
      ...actions,
      edit: (field, text) => {
        actions.edit(field, text)
        if (field === 'authMode' && text !== 'password') actions.edit('sshPassword', '')
        if (field === 'host' || field === 'username' || field === 'sshPort') void this.readPassword()
      },
      resetField: (field) => {
        actions.resetField(field)
        if (field === 'authMode' && this.form.field(field).text !== 'password') actions.edit('sshPassword', '')
        void this.readPassword()
      },
      discard: () => { actions.discard(); void this.readPassword() },
      loadRecords: () => { void this.loadRecords() },
      refreshRecord: (submissionId) => { void this.changeRecord(submissionId, 'refresh') },
      cancelRecord: (submissionId) => { void this.changeRecord(submissionId, 'cancel') },
    }
  }
}
