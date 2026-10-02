/** Native keyboard and preference adapter for the published DSH Desktop protocols. */
import { ipcMain, type BrowserWindow, type Input, type IpcMainInvokeEvent } from 'electron'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ShortcutPersistence, initialShortcutConfig, parseShortcutDefinitions, parseShortcutEdit, effectiveShortcuts, bindingKey } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { NormalizedBinding, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform, ShortcutRevision } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { readApiKeyPresence } from './credential-presence.ts'
import { NATIVE_IPC } from './native-protocol.ts'

/**
 * Connect one owned window to durable shortcut preferences and safe onboarding metadata.
 * @param window - local application window.
 * @param userData - private desktop preference directory.
 * @param assertSender - requires the authenticated main frame of this window.
 * @returns a disposer for IPC handlers, input listeners and pending publications.
 */
export function installNativeBridge(window: BrowserWindow, userData: string,
  assertSender: (event: IpcMainInvokeEvent) => BrowserWindow): () => void {
  const platform: ShortcutPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const file = resolve(userData, 'keybindings.json')
  let definitions: readonly ShortcutDefinition[] = []; let snapshot: ShortcutConfigSnapshot = initialShortcutConfig()
  let bindings: readonly NormalizedBinding[] = []
  let recording = false; let onboarding = false; let deadKey = false
  const held = new Set<string>(); const consumed = new Set<string>()
  const persistence = new ShortcutPersistence({
    async read() {
      try { return await readFile(file, 'utf8') }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error }
    },
    write: raw => writeFileAtomic(file, raw, { mode: 0o600, dirMode: 0o700 }),
  }, 'desktop', platform, true, next => {
    snapshot = next
    bindings = next.status === 'loading' ? [] : effectiveShortcuts(definitions, next.document, 'desktop', platform)
      .flatMap(row => row.binding !== null && row.issue === null && row.conflicts.length === 0 ? [row.binding] : [])
    held.clear(); consumed.clear()
    if (!window.isDestroyed()) window.webContents.send(NATIVE_IPC.shortcutsChanged, next)
  })
  ipcMain.handle(NATIVE_IPC.shortcutsGet, (event, value: unknown) => {
    assertSender(event); definitions = parseShortcutDefinitions(value)
    persistence.setDefinitions(definitions)
    return persistence.readCurrent()
  })
  ipcMain.handle(NATIVE_IPC.shortcutsEdit, (event, edit: unknown, revision: unknown) => {
    assertSender(event)
    if (typeof revision !== 'string') throw new Error('Invalid shortcut revision')
    return persistence.edit(parseShortcutEdit(edit), revision as ShortcutRevision)
  })
  ipcMain.handle(NATIVE_IPC.shortcutsRecording, (event, active: unknown) => {
    assertSender(event)
    if (typeof active !== 'boolean') throw new Error('Invalid shortcut recording state')
    recording = active; held.clear(); consumed.clear(); window.webContents.setIgnoreMenuShortcuts(active)
  })
  ipcMain.handle(NATIVE_IPC.closeWindow, (event, revision: unknown) => {
    assertSender(event)
    if (revision === snapshot.revision && snapshot.status === 'ready' && !recording && !onboarding && window.isFocused()) window.close()
  })
  ipcMain.handle(NATIVE_IPC.apiKeyPresence, event => {
    const target = assertSender(event)
    return readApiKeyPresence(new URL(target.webContents.mainFrame.url).origin, (url, init) => target.webContents.session.fetch(url, init))
  })
  ipcMain.handle(NATIVE_IPC.onboardingActive, (event, active: unknown) => {
    assertSender(event)
    if (typeof active !== 'boolean') throw new Error('Invalid onboarding state')
    onboarding = active
  })
  const reset = (): void => { held.clear(); consumed.clear(); deadKey = false }
  const beforeInput = (event: Electron.Event, input: Input): void => {
    if (event.defaultPrevented || !window.isFocused() || !window.isEnabled() || snapshot.status === 'loading') { reset(); return }
    if (onboarding) { reset(); return }
    if (input.type === 'keyUp') {
      held.delete(input.code)
      if (consumed.delete(input.code)) event.preventDefault()
      return
    }
    if (input.type !== 'keyDown') return
    if (input.isComposing || input.key === 'Dead' || input.modifiers?.includes('altgr')) { reset(); deadKey = true; return }
    if (deadKey) { reset(); return }
    if (recording) { reset(); return }
    const focused = window.webContents.focusedFrame
    if (focused !== window.webContents.mainFrame) { reset(); return }
    held.add(input.code)
    const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(modifier => input[modifier])
    const binding = bindings.find(candidate => {
      return held.has(candidate.code) && (candidate.secondCode === undefined || held.has(candidate.secondCode))
        && (input.code === candidate.code || input.code === candidate.secondCode)
        && bindingKey(candidate) === bindingKey({ ...candidate, modifiers })
    })
    if (binding === undefined) return
    event.preventDefault()
    consumed.add(binding.code)
    if (binding.secondCode !== undefined) consumed.add(binding.secondCode)
    window.webContents.send(NATIVE_IPC.shortcutsInput, { kind: 'keyboard', revision: snapshot.revision, frameName: '',
      code: binding.code, ...(binding.secondCode === undefined ? {} : { secondCode: binding.secondCode }),
      repeat: input.isAutoRepeat, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta })
  }
  window.webContents.on('before-input-event', beforeInput)
  window.on('blur', reset)
  return () => {
    persistence.dispose(); window.off('blur', reset)
    if (!window.isDestroyed()) window.webContents.off('before-input-event', beforeInput)
    for (const channel of [NATIVE_IPC.shortcutsGet, NATIVE_IPC.shortcutsEdit, NATIVE_IPC.shortcutsRecording,
      NATIVE_IPC.closeWindow, NATIVE_IPC.apiKeyPresence, NATIVE_IPC.onboardingActive]) ipcMain.removeHandler(channel)
  }
}
