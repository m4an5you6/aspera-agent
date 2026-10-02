/** Narrow, isolated adapter for the published DSH Windows caption and account navigation. */
import { contextBridge, ipcRenderer } from 'electron'
import { shellCopy } from './locales.ts'
import type { DesktopKeyboardApi, DesktopShortcutsApi, ShortcutConfigSnapshot, DesktopShortcutInput } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { NATIVE_IPC } from './native-protocol.ts'

if (process.isMainFrame && location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  const shortcuts: DesktopShortcutsApi = {
    get: definitions => ipcRenderer.invoke(NATIVE_IPC.shortcutsGet, definitions),
    edit: (edit, revision) => ipcRenderer.invoke(NATIVE_IPC.shortcutsEdit, edit, revision),
    recording: active => ipcRenderer.invoke(NATIVE_IPC.shortcutsRecording, active),
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, snapshot: ShortcutConfigSnapshot): void => { listener(snapshot) }
      ipcRenderer.on(NATIVE_IPC.shortcutsChanged, handle)
      return () => { ipcRenderer.off(NATIVE_IPC.shortcutsChanged, handle) }
    },
  }
  const keyboard: DesktopKeyboardApi = {
    closeWindow: revision => ipcRenderer.invoke(NATIVE_IPC.closeWindow, revision),
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, input: DesktopShortcutInput): void => { listener(input) }
      ipcRenderer.on(NATIVE_IPC.shortcutsInput, handle)
      return () => { ipcRenderer.off(NATIVE_IPC.shortcutsInput, handle) }
    },
  }
  contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1, shortcuts, keyboard })
  contextBridge.exposeInMainWorld('asperaDesktop', {
    setAttentionCount: (count: number): Promise<void> => ipcRenderer.invoke('aspera-desktop-attention', count),
  })
  contextBridge.exposeInMainWorld('dshOnboarding', {
    hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(NATIVE_IPC.apiKeyPresence),
    setActive: (active: boolean): void => { void ipcRenderer.invoke(NATIVE_IPC.onboardingActive, active).catch((error: unknown) => { console.error(error) }) },
  })
  const mark = (): void => {
    document.documentElement.dataset.platform = process.platform
    if (process.platform === 'win32') {
      document.documentElement.dataset.windowsTitlebar = ''
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
    }
  }
  if (document.documentElement !== null) mark()
  const install = (): void => {
    mark()
    if (process.platform !== 'win32') return
    const host = document.createElement('div'); host.dataset.windowsMenu = ''
    const shadow = host.attachShadow({ mode: 'open' }); const style = document.createElement('style')
    style.textContent = `:host{position:fixed;top:0;left:var(--dsh-windows-menu-start,48px);z-index:1100;height:40px;display:flex;align-items:center;font-family:var(--dsw-font-family);-webkit-app-region:no-drag}div{display:flex;gap:2px}button{height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;cursor:default}button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}`
    const bar = document.createElement('div'); bar.setAttribute('role', 'menubar')
    const buttons = (['application', 'edit'] as const).map(kind => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem')
      button.setAttribute('aria-haspopup', 'menu')
      button.addEventListener('mousedown', event => { event.preventDefault() })
      button.addEventListener('click', () => {
        const bounds = button.getBoundingClientRect()
        void ipcRenderer.invoke('aspera-desktop-menu', { kind, x: Math.round(bounds.left), y: Math.round(bounds.bottom) })
          .catch((error: unknown) => { console.error(error) })
      })
      bar.append(button); return button
    })
    const probe = document.createElement('span'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)'
    document.body.append(probe)
    let previousAppearance = ''
    const refresh = (): void => {
      const locale = document.documentElement.lang; const copy = shellCopy(locale)
      buttons[0]!.textContent = copy.application; buttons[1]!.textContent = copy.edit
      bar.setAttribute('aria-label', copy.menuBar)
      const computed = getComputedStyle(probe)
      const appearance = { locale, color: computed.backgroundColor, symbolColor: computed.color }
      const key = JSON.stringify(appearance)
      if (key !== previousAppearance) {
        previousAppearance = key
        void ipcRenderer.invoke('aspera-desktop-appearance', appearance).catch((error: unknown) => { console.error(error) })
      }
      if (document.querySelector('[data-shell-overlay]') !== null && !host.isConnected) document.body.append(host)
    }
    shadow.append(style, bar)
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'], childList: true })
    observer.observe(document.head, { childList: true, subtree: true })
    window.addEventListener('pagehide', () => { observer.disconnect(); probe.remove(); host.remove() }, { once: true })
    refresh()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}
