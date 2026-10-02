/** Private main-frame IPC names shared by the sandboxed preload and window owner. */
export const NATIVE_IPC = {
  shortcutsGet: 'aspera:shortcuts-get', shortcutsEdit: 'aspera:shortcuts-edit',
  shortcutsRecording: 'aspera:shortcuts-recording', shortcutsChanged: 'aspera:shortcuts-changed',
  shortcutsInput: 'aspera:shortcuts-input', closeWindow: 'aspera:close-window',
  apiKeyPresence: 'aspera:api-key-presence', onboardingActive: 'aspera:onboarding-active',
} as const
