/** Locale bundles for the built-in plugins settings section and the plugin configuration pages. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'subagentTitle' | 'subagentDescription' | 'subagentLimitsTitle'
  | 'subagentMaxDepth'
  | 'subagentDepthHelpLabel' | 'subagentDepthHelp'
  | 'subagentDepthZero' | 'subagentDepthOne' | 'subagentDepthOverride'
  | 'subagentMaxActive'
  | 'subagentCapacityHelpLabel' | 'subagentCapacityHelp'
  | 'subagentDepthInvalid'
  | 'subagentCapacityInvalid'
  | 'subagentModelSelectionTitle'
  | 'subagentModelSelectionToggle' | 'subagentModelSelectionChoose' | 'subagentModelSelectionAllowed'
  | 'subagentModelSelectionLoading' | 'subagentModelSelectionLoadFailed' | 'subagentModelSelectionRetry'
  | 'subagentModelSelectionPartial' | 'subagentModelSelectionUnavailable'
  | 'subagentModelSelectionUnavailableGroup' | 'subagentModelSelectionEmpty'
  | 'subagentModelSelectionRequired' | 'subagentModelSelectionConflict' | 'subagentModelSelectionOff'
  | 'experimentTitle' | 'experimentDescription' | 'experimentTargetIntro'
  | 'experimentHost' | 'experimentHostHint' | 'experimentSshPort' | 'experimentSshPortHint'
  | 'experimentRemotePort' | 'experimentRemotePortHint' | 'experimentRemoteRoot' | 'experimentRemoteRootHint'
  | 'experimentLocalRepo' | 'experimentLocalRepoHint' | 'experimentIdentityFile' | 'experimentIdentityFileHint'
  | 'experimentDataRoots' | 'experimentDataRootsHint' | 'experimentTokenRef' | 'experimentTokenRefHint'
  | 'experimentAgentCredentialRefs' | 'experimentAgentCredentialRefsHint'
  | 'experimentToolTimeoutMs' | 'experimentToolTimeoutMsHint' | 'experimentInvalidList'
  | 'experimentRecordsTitle' | 'experimentReload' | 'experimentLoading' | 'experimentEmpty'
  | 'experimentReserved' | 'experimentAccepted' | 'experimentComplete' | 'experimentBlocked'
  | 'experimentFailed' | 'experimentCancelled' | 'experimentInterrupted' | 'experimentUnknown'
  | 'experimentLegacyTarget' | 'experimentSubmissionId' | 'experimentLocalGoal'
  | 'experimentRemoteSession' | 'experimentRemoteGoal' | 'experimentArtifacts'
  | 'experimentWorkerLog' | 'experimentDetail' | 'experimentRefresh' | 'experimentCancel'
  | 'experimentHandover'
  | 'experimentBytes' | 'experimentReceiverToken' | 'experimentReceiverTokenHint'
  | 'experimentTokenSet' | 'experimentTokenUnset'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Built-in plugins',
  title: 'Built-in plugins',
  intro: 'Inspect the plugins this deployment ships.',
  tabs: 'Plugin views',
  empty: 'This deployment exposes no plugin views.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'The DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
  subagentTitle: 'Subagent',
  subagentDescription: 'Set Subagent recursion depth, count, and models.',
  subagentLimitsTitle: 'Limits',
  subagentMaxDepth: 'Maximum recursion depth',
  subagentDepthHelpLabel: 'About maximum recursion depth',
  subagentDepthHelp: 'Limits how many levels of Subagents an Agent can create.',
  subagentDepthZero: 'Disable Subagents',
  subagentDepthOne: 'Only the main Agent can create Subagents',
  subagentDepthOverride: 'If a tool defines its own maximum recursion depth, that setting takes precedence.',
  subagentMaxActive: 'Subagent parallelism limit',
  subagentCapacityHelpLabel: 'About the Subagent parallelism limit',
  subagentCapacityHelp: 'Total live Subagents under the same main Agent, across all recursion levels. The main Agent is excluded. New start requests are rejected when the limit is reached.',
  subagentDepthInvalid: 'Enter a whole number of 0 or more.',
  subagentCapacityInvalid: 'Enter a whole number of 1 or more.',
  subagentModelSelectionTitle: 'Model selection',
  subagentModelSelectionToggle: 'Allow agents to choose models for Subagents',
  subagentModelSelectionChoose: 'When enabled, agents can choose a provider, model, and reasoning effort for each Subagent from the authorized models below. Applies only to new sessions.',
  subagentModelSelectionAllowed: 'Models agents may choose',
  subagentModelSelectionLoading: 'Loading models…',
  subagentModelSelectionLoadFailed: 'Models could not be loaded.',
  subagentModelSelectionRetry: 'Retry',
  subagentModelSelectionPartial: 'Some model providers could not be loaded; saved choices remain removable.',
  subagentModelSelectionUnavailable: 'Currently unavailable',
  subagentModelSelectionUnavailableGroup: 'Saved but currently unavailable',
  subagentModelSelectionEmpty: 'No model provider currently advertises a model.',
  subagentModelSelectionRequired: 'Select at least one model before saving.',
  subagentModelSelectionConflict: 'Settings changed elsewhere. Discard your draft and try again.',
  subagentModelSelectionOff: 'Subagents use configured defaults or inherit the parent agent\'s model. Saved model choices are retained.',
  experimentTitle: 'GPU experiment dispatch',
  experimentDescription: 'Configure a GPU server and follow experiments after remote handover.',
  experimentTargetIntro: 'New preparations use these settings. Each submitted experiment keeps its original server and credential references.',
  experimentHost: 'SSH host', experimentHostHint: 'Known-hosts-verified destination for the GPU server.',
  experimentSshPort: 'SSH port', experimentSshPortHint: 'Port for the SSH connection.',
  experimentRemotePort: 'Worker port', experimentRemotePortHint: 'Loopback receiver port reached through SSH.',
  experimentRemoteRoot: 'Remote directory', experimentRemoteRootHint: 'Absolute private deployment directory on the GPU server.',
  experimentLocalRepo: 'Local source directory', experimentLocalRepoHint: 'Absolute checkout to deploy; blank uses the current working directory.',
  experimentIdentityFile: 'SSH identity file', experimentIdentityFileHint: 'Optional private key path for unattended login.',
  experimentDataRoots: 'Local data directories', experimentDataRootsHint: 'Absolute directories from which dataset files may be copied; separate with commas.',
  experimentTokenRef: 'Receiver token reference', experimentTokenRefHint: 'Credential reference; the secret value stays in the credential store.',
  experimentAgentCredentialRefs: 'Model credential references', experimentAgentCredentialRefsHint: 'References copied to the remote worker; separate with commas.',
  experimentToolTimeoutMs: 'Tool timeout (ms)', experimentToolTimeoutMsHint: 'Maximum time for preparation and submission operations.',
  experimentInvalidList: 'Enter comma-separated values without empty items.',
  experimentRecordsTitle: 'Experiments', experimentReload: 'Reload', experimentLoading: 'Loading experiments…',
  experimentEmpty: 'No experiment has been submitted from this deployment.',
  experimentReserved: 'Reserved', experimentAccepted: 'Accepted', experimentComplete: 'Complete',
  experimentBlocked: 'Blocked', experimentFailed: 'Failed', experimentCancelled: 'Cancelled',
  experimentInterrupted: 'Interrupted', experimentUnknown: 'Awaiting receipt',
  experimentLegacyTarget: 'Server not saved', experimentSubmissionId: 'Submission ID',
  experimentLocalGoal: 'Local Goal', experimentRemoteSession: 'Remote session',
  experimentRemoteGoal: 'Remote Goal', experimentArtifacts: 'Artifacts',
  experimentWorkerLog: 'Worker log', experimentDetail: 'Detail',
  experimentHandover: 'Local dispatch complete; the remote experiment has taken over.',
  experimentRefresh: 'Refresh', experimentCancel: 'Cancel', experimentBytes: 'bytes',
  experimentReceiverToken: 'Receiver token',
  experimentReceiverTokenHint: 'Saved in the credential store under the reference above; leave blank to keep the current token.',
  experimentTokenSet: 'A token is configured.', experimentTokenUnset: 'No token is configured.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '内置插件',
  title: '内置插件',
  intro: '查看内置部署的插件列表',
  tabs: '插件视图',
  empty: '本部署没有开放任何插件视图。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  subagentTitle: 'Subagent',
  subagentDescription: '设置 Subagent 的递归层级、数量和模型。',
  subagentLimitsTitle: '运行限制',
  subagentMaxDepth: '最大递归深度',
  subagentDepthHelpLabel: '最大递归深度说明',
  subagentDepthHelp: '限制 Agent 创建 Subagent 的递归层级。',
  subagentDepthZero: '禁用 Subagent',
  subagentDepthOne: '仅允许主 Agent 创建 Subagent',
  subagentDepthOverride: '如果某个工具单独设置了最大递归深度，以该工具的设置为准。',
  subagentMaxActive: 'Subagent 并行数量上限',
  subagentCapacityHelpLabel: 'Subagent 并行数量上限说明',
  subagentCapacityHelp: '同一主 Agent 下，所有递归层级同时存活的 Subagent 总数，主 Agent 不计入。达到上限时，新的启动请求会被拒绝。',
  subagentDepthInvalid: '请输入不小于 0 的整数。',
  subagentCapacityInvalid: '请输入不小于 1 的整数。',
  subagentModelSelectionTitle: '模型选择',
  subagentModelSelectionToggle: '允许 Agent 为 Subagent 选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个 Subagent 选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionConflict: '设置已在其他位置更新。请放弃修改后重试。',
  subagentModelSelectionOff: '关闭后，Subagent 使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',
  experimentTitle: 'GPU 实验派发',
  experimentDescription: '配置 GPU 服务器，并在远端接管后查看实验状态。',
  experimentTargetIntro: '新的准备工作使用此处的配置。已提交的实验保留原服务器和凭据引用。',
  experimentHost: 'SSH 主机', experimentHostHint: '已通过 known_hosts 验证的 GPU 服务器地址。',
  experimentSshPort: 'SSH 端口', experimentSshPortHint: 'SSH 连接所用端口。',
  experimentRemotePort: '工作器端口', experimentRemotePortHint: '通过 SSH 访问的远端回环接收端口。',
  experimentRemoteRoot: '远端目录', experimentRemoteRootHint: 'GPU 服务器上的私有部署绝对路径。',
  experimentLocalRepo: '本地源码目录', experimentLocalRepoHint: '待部署源码的绝对路径；留空使用当前工作目录。',
  experimentIdentityFile: 'SSH 身份文件', experimentIdentityFileHint: '用于无人值守登录的可选私钥路径。',
  experimentDataRoots: '本地数据目录', experimentDataRootsHint: '可复制数据集文件的绝对路径，用逗号分隔。',
  experimentTokenRef: '接收端令牌引用', experimentTokenRefHint: '凭据引用；密钥值保存在凭据存储中。',
  experimentAgentCredentialRefs: '模型凭据引用', experimentAgentCredentialRefsHint: '复制到远端工作器的凭据引用，用逗号分隔。',
  experimentToolTimeoutMs: '工具超时（毫秒）', experimentToolTimeoutMsHint: '准备和提交操作的最长时间。',
  experimentInvalidList: '请用逗号分隔，且不要留空项。',
  experimentRecordsTitle: '实验', experimentReload: '重新加载', experimentLoading: '正在加载实验…',
  experimentEmpty: '此部署尚未提交实验。',
  experimentReserved: '已预留', experimentAccepted: '已接管', experimentComplete: '已完成',
  experimentBlocked: '已阻塞', experimentFailed: '失败', experimentCancelled: '已取消',
  experimentInterrupted: '已中断', experimentUnknown: '等待回执',
  experimentLegacyTarget: '未保存服务器', experimentSubmissionId: '提交编号',
  experimentLocalGoal: '本地 Goal', experimentRemoteSession: '远端会话',
  experimentRemoteGoal: '远端 Goal', experimentArtifacts: '产物路径',
  experimentWorkerLog: '工作器日志', experimentDetail: '详情',
  experimentHandover: '本机派发完成，远端实验已接管',
  experimentRefresh: '刷新', experimentCancel: '取消', experimentBytes: '字节',
  experimentReceiverToken: '接收端令牌',
  experimentReceiverTokenHint: '按上方引用保存在凭据存储中；留空保留当前令牌。',
  experimentTokenSet: '已配置令牌。', experimentTokenUnset: '未配置令牌。',
}
