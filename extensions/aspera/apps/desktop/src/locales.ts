/** Native shell copy; the application page retains its DSH locale dictionaries. */
const en = {
  open: 'Open Aspera', quit: 'Quit Aspera', view: 'View', reload: 'Reload page', tools: 'Developer tools',
  loading: 'Starting Aspera', failed: 'Aspera could not start', retry: 'Restart',
  application: 'Application', edit: 'Edit', menuBar: 'Application menu',
  pending: '{count} experiments need attention',
}
const zh: typeof en = {
  open: '打开 Aspera', quit: '退出 Aspera', view: '视图', reload: '重新加载页面', tools: '开发者工具',
  loading: '正在启动 Aspera', failed: 'Aspera 启动失败', retry: '重新启动',
  application: '应用', edit: '编辑', menuBar: '应用菜单',
  pending: '{count} 个实验待处理',
}
/**
 * Select native menu and startup labels from the system language.
 * @param locale - Electron system locale.
 * @returns one complete shell dictionary.
 */
export function shellCopy(locale: string): typeof en { return locale.toLowerCase().startsWith('zh') ? zh : en }
