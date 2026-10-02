/** Independent Electron carrier; the management application boots through a dsh profile. */
import { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, ipcMain, nativeTheme } from 'electron'
import { resolve, dirname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareDesktopProfile } from './profile.ts'
import { DesktopHost } from './host-process.ts'
import { isOwnedNavigation, isExternalLink } from './protocol.ts'
import { shellCopy } from './locales.ts'
import { installNativeBridge } from './native.ts'
import z from 'zod'
import { attentionCountSchema, attentionArtwork } from './attention.ts'

const application = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = app.isPackaged ? resolve(process.resourcesPath, 'runtime.asar') : resolve(application, '../..')
if (process.env.ASPERA_DESKTOP_USER_DATA_DIR !== undefined) {
  const userData = resolve(process.env.ASPERA_DESKTOP_USER_DATA_DIR)
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  app.setPath('userData', userData)
}
app.setName('Aspera')
app.setAppUserModelId('org.aspera.desktop')

function duration(name: string, fallback: number): number {
  if (process.env[name] === undefined) return fallback
  const value = Number(process.env[name])
  if (!Number.isInteger(value) || value < 1000 || value > 2_147_483_647) throw new Error(`${name} must be an integer from 1000 to 2147483647`)
  return value
}

let window: BrowserWindow | undefined; let tray: Tray | undefined; let host: DesktopHost | undefined
let quitting = false; let failureOpen = false; let quitPromise: Promise<void> | undefined
let ownedOrigin: string | undefined
let menuLocale = 'en'
let attentionCount = 0
const menuRequest = z.object({ kind: z.enum(['application', 'edit']), x: z.number().int().min(0), y: z.number().int().min(0) }).strict()
const appearanceRequest = z.object({ locale: z.string().max(64), color: z.string().regex(/^rgba?\([\d.,\s]+\)$/),
  symbolColor: z.string().regex(/^rgba?\([\d.,\s]+\)$/) }).strict()

function ownedCaller(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  if (window === undefined || window.isDestroyed() || ownedOrigin === undefined || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || !isOwnedNavigation(event.senderFrame.url, ownedOrigin)) throw new Error('Desktop operation requires the owned application frame')
  return window
}

function showWindow(): void { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() }

function updateAttention(): void {
  if (process.platform !== 'win32' || window === undefined || window.isDestroyed()) return
  const label = attentionArtwork(attentionCount)
  const copy = shellCopy(menuLocale)
  const description = attentionCount === 0 ? 'Aspera' : copy.pending.replace('{count}', String(attentionCount))
  const badge = resolve(application, 'resources/badges', `${label}.png`)
  if (label !== '' && !existsSync(badge)) throw new Error('Packaged attention artwork is missing')
  window.setOverlayIcon(label === '' ? null : nativeImage.createFromPath(badge), description)
  if (tray !== undefined) {
    const trayPath = label !== '' && !window.isVisible() ? resolve(application, 'resources/badges', `tray-${label}.png`) : resolve(application, 'resources/icon.png')
    tray.setImage(nativeImage.createFromPath(trayPath).resize({ width: 24, height: 24 }))
    tray.setToolTip(description)
  }
}

async function showFailure(error: unknown): Promise<void> {
  if (quitting || failureOpen) return
  failureOpen = true
  const copy = shellCopy(app.getLocale())
  const detail = (error instanceof Error ? error.message : String(error)).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>').slice(-1400)
  console.error(detail)
  const choice = await dialog.showMessageBox({ type: 'error', title: 'Aspera', message: copy.failed, detail,
    buttons: [copy.retry, copy.quit], defaultId: 0, cancelId: 1 })
  if (choice.response === 0) app.relaunch()
  app.quit()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  app.on('before-quit', event => {
    event.preventDefault()
    if (quitPromise !== undefined) return
    quitting = true
    quitPromise = (async () => { try { await host?.stop(); app.exit(0) }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); app.exit(1) } })()
  })
  void app.whenReady().then(async () => {
    const copy = shellCopy(app.getLocale())
    menuLocale = app.getLocale()
    const home = resolve(process.env.ASPERA_HOME || resolve(app.getPath('userData'), 'dsh'))
    prepareDesktopProfile(home, runtime, resolve(application, 'lib/host.js'))
    const icon = resolve(application, 'resources/icon.png')
    window = new BrowserWindow({ width: 1280, height: 820, minWidth: 520, minHeight: 600, title: 'Aspera',
      ...(existsSync(icon) ? { icon } : {}),
      ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { height: 40,
        color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb', symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' } } : {}),
      webPreferences: { preload: resolve(application, 'lib/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        partition: 'persist:aspera', webviewTag: false, backgroundThrottling: false },
    })
    window.on('page-title-updated', event => { event.preventDefault() })
    window.on('hide', updateAttention); window.on('show', updateAttention)
    window.on('close', event => { if (!quitting && tray !== undefined) { event.preventDefault(); window?.hide() } else app.quit() })
    window.webContents.on('render-process-gone', (_event, details) => { void showFailure(new Error(`Application page stopped: ${details.reason}`)) })
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    window.webContents.session.setPermissionCheckHandler(() => false)
    const applicationMenu = Menu.buildFromTemplate([
      { label: 'Aspera', submenu: [{ label: copy.open, click: showWindow }, { type: 'separator' }, { label: copy.quit, click: () => { app.quit() } }] },
      { label: copy.view, submenu: [{ label: copy.reload, role: 'reload' }, { label: copy.tools, role: 'toggleDevTools', accelerator: 'F12' }] },
    ])
    Menu.setApplicationMenu(process.platform === 'win32' ? null : applicationMenu)
    ipcMain.handle('aspera-desktop-appearance', (event, request: unknown) => {
      const target = ownedCaller(event); const appearance = appearanceRequest.parse(request)
      menuLocale = appearance.locale
      updateAttention()
      if (process.platform === 'win32') target.setTitleBarOverlay({ height: 40, color: appearance.color, symbolColor: appearance.symbolColor })
    })
    ipcMain.handle('aspera-desktop-menu', (event, request: unknown) => {
      const target = ownedCaller(event); const menu = menuRequest.parse(request)
      const bounds = target.getContentBounds()
      if (menu.x > bounds.width || menu.y > bounds.height) throw new Error('Menu anchor is outside the application window')
      const locale = shellCopy(menuLocale)
      const popup = menu.kind === 'application' ? Menu.buildFromTemplate([
        { label: locale.open, click: showWindow }, { label: locale.reload, role: 'reload' },
        { type: 'separator' }, { label: locale.quit, click: () => { app.quit() } },
      ]) : Menu.buildFromTemplate([{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { role: 'selectAll' }])
      popup.popup({ window: target, x: menu.x, y: menu.y })
    })
    ipcMain.handle('aspera-desktop-attention', (event, count: unknown) => {
      ownedCaller(event)
      attentionCount = attentionCountSchema.parse(count)
      updateAttention()
    })
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        event.preventDefault(); window?.webContents.toggleDevTools()
      }
    })
    const disposeNative = installNativeBridge(window, app.getPath('userData'), ownedCaller)
    app.once('will-quit', disposeNative)
    if (process.platform === 'win32' && existsSync(icon)) {
      tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }))
      tray.setToolTip('Aspera'); tray.on('click', showWindow)
      tray.setContextMenu(Menu.buildFromTemplate([{ label: copy.open, click: showWindow }, { label: copy.quit, click: () => { app.quit() } }]))
    }
    const loading = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;height:100vh;display:grid;place-items:center;font:16px system-ui;color:#506070;background:#f7f9fb}.box{display:grid;justify-items:center;gap:20px}.spinner{width:30px;height:30px;border:3px solid #d9e6eb;border-top-color:#32756c;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}</style></head><body><div class="box"><div class="spinner"></div>${copy.loading}</div></body></html>`
    const loadingUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(loading)
    const pnpm = app.isPackaged ? resolve(runtime, 'node_modules/pnpm/bin/pnpm.cjs') : resolve(application, 'node_modules/pnpm/bin/pnpm.cjs')
    if (!existsSync(pnpm)) throw new Error('The bundled pnpm runtime is missing')
    host = new DesktopHost({ executable: process.execPath,
      launcher: app.isPackaged ? resolve(runtime, 'launch.js') : resolve(application, 'lib/launch.js'), runtime, home, pnpm,
      startupMs: duration('ASPERA_DESKTOP_STARTUP_MS', 60000), shutdownMs: duration('ASPERA_DESKTOP_SHUTDOWN_MS', 30000) })
    const [, url] = await Promise.all([window.loadURL(loadingUrl), host.start(error => { void showFailure(error) })])
    if (quitting || window.isDestroyed()) return
    const origin = new URL(url).origin
    ownedOrigin = origin
    const external = (destination: string): void => { if (isExternalLink(destination)) void shell.openExternal(destination).catch(error => { console.error(error.message) }) }
    window.webContents.on('will-navigate', (event, destination) => {
      if (!isOwnedNavigation(destination, origin)) { event.preventDefault(); external(destination) }
    })
    window.webContents.on('will-redirect', (event, destination) => { if (!isOwnedNavigation(destination, origin)) event.preventDefault() })
    window.webContents.setWindowOpenHandler(({ url: destination }) => { external(destination); return { action: 'deny' } })
    await window.loadURL(url)
  }).catch((error: unknown) => { void showFailure(error) })
}
