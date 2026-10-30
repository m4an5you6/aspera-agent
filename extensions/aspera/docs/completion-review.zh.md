# 完成证据与历史复验

[English](completion-review.md) | 中文

## 概要

Aspera 在结束执行 Goal 前检查完成条件，并在 worker 最终收尾时再次检查。因完成证据缺失而失败且已释放资源的实验，可以请求独立的只读补录复验。训练、环境、原结果、日志、Session 和固定发布继续保留。

## 目录

- [正常完成](#normal-completion)
- [复验已有结果](#review-an-existing-result)
- [验收与归属](#verification-and-ownership)
- [在原实验恢复验收](#recover-acceptance-on-the-original-experiment)
- [持久记录与接口](#persistence-and-api)
- [验证](#validation)

<a id="normal-completion"></a>
## 正常完成

`inspect_experiment_completion`、`finish_experiment(completed)` 和最终收尾共用同一套[完成检查](../packages/runtime/src/completion-check.ts)。要求批准计划与执行 Session 的步骤报告匹配且已完成、每个所选节点均有执行记录及生效参数、环境通过验收、成功命令已退出或注册服务健康、脚本及声明的产物可读取。可选来源引用由程序计算摘要并再次核对。执行记录写入失败时保留未提交标记，阻止完成。

缺少证据时返回具体节点、失败检查及补录说明，原 Goal 保持活动。执行 Agent 使用 `record_experiment_execution` 记录实际框架、版本、脚本、环境、参数、产物和评估，再请求完成。Markdown 报告、`plan_json`、完成说明或已完成步骤报告均不能替代执行记录。不得为修复缺失记录重新运行已结束的命令。

<a id="review-an-existing-result"></a>
## 复验已有结果

打开符合资格的实验，选择**补录并重新验收**。证据遗漏导致的失败要求批准计划、原完成 Goal 与完成工具调用证据、命令退出确认及全部原资源释放。已释放的受阻续训还必须按[阶段复验规则](finalization.zh.md#historical-review)独立确认训练终点及原 blocked finish 证据。其他训练失败、取消和中断不适用。仅匹配错误字符串不足以启动补录。全部原节点必须仍可核验。

Host 使用原执行模型，在独立补录 Session 中启动标准 DSH Agent。工具允许读取原要求、步骤报告、命令结果、文件与轨迹，以及检查完成条件、补录执行证据和请求复验。不提供命令、安装、训练、推理、服务或删除工具。取消只停止该 Agent 及读取；隐藏窗口或切换页面后继续。重启 Aspera 后恢复原操作和 Session。受阻重试通过 DSH 的版本核对接口恢复已有补录 Goal，保留身份和轮次预算；原训练 Goal 保持停止。重复请求复用原操作。

程序提交有效复验回执后，概览和列表才显示**复验通过**。原失败或受阻结果与时间继续可查看。受阻时显示缺失证据和重试入口，停止动画。补录 Agent 记录有独立只读轨迹选项，可从本机读取。未缓存的补录附件在离线时不可用。

<a id="verification-and-ownership"></a>
## 验收与归属

复验身份绑定实验、原提交摘要、计划版本、执行 Session、结果版本及所选节点。每个来源必须是原工作区文件，代次、大小和 SHA-256 均由程序独立读取。参数和评估值必须匹配已保存的结构化证据；脚本和产物必须引用实际路径。要求非空结果证据。报告或模型声明不能替代文件读取。提交独立回执前，再次检查来源、环境、原结果、节点分配和命令释放。文件变化或身份冲突会阻止发布。

Agent 可通过 `register_experiment_stage` 更正尚未通过核验的历史阶段文件引用，并将当前 `assessment.revision` 作为 `expected_revision` 提交。原训练尝试、命令和批准要求固定不变。更正使旧检查失效，必须重新核验；已通过的绑定不能修改。未使用的文件字段应省略，不能填写 `false` 或空路径。原失败检查保留在补录 Session 中。

已有 `pyenv` 可以通过只读核对解释器身份、`pyvenv.cfg` 和依赖元数据登记为历史环境，框架版本必须匹配。此操作不执行实验代码、不导入包、不安装、修改或复制依赖。记录只用于原实验复验，不进入共享包库，也不替代新实验的受管环境要求。

协议 4 的认证历史读取继续可用。控制进程离线或版本较旧时，使用程序拥有的 [SSH 证据读取器](../packages/dispatch/src/completion-reader.ts)，检查运行目录归属、原分配释放和固定发布身份。拒绝路径越界、符号链接和嵌套挂载。读取器不替换发布，不修改原任务台账。即使本机历史可读取，不可达节点或缺失原文件仍为未核验。复验不重新运行训练、评估或推理来制造证据。

凭据脱敏保留已解析 JSON 和完整 JSONL 记录的结构，包括嵌套工具结果；空凭据字段仍为 null。参数的原字段名与值保持可读。补录被拒绝时，一次列出全部参数、评估和产物不匹配项，以及来源中可用的值和字段名。无效或不完整的结构化证据继续待验。同一文件支持多种证据用途时，每次补录或最终复验只读取一次；最终复验仍重新读取来源身份。

<a id="recover-acceptance-on-the-original-experiment"></a>
## 在原实验恢复验收

`recoverExperimentAcceptance(id, recoveryId?)` 将已有的纯推理执行关联到已释放的训练结果。程序核对所选节点、批准的原生终点、产生命令成功退出、checkpoint 文件身份与摘要，以及原公网模型 URL。原实验继续作为顶层任务。此前推理受阻且确认释放后，Host 启动具有独立 Session 和固定提交的下属纯推理运行时；原配置文本与程序复用线索供 Agent 自主修复。原 Goal 和原提交保持不变。原详情页展示恢复进度、执行轨迹和关联服务。`experimentAcceptanceRecoveryStatus(id)` 读取保留的观察时间与诊断。

恢复来源条目保留原文件字节的 `sha256`，增加所提供 UTF-8 文本的 `textSha256` 和标记凭据脱敏的 `textRedacted`。提供文本的摘要在脱敏后计算；修改后的预览供 Agent 审阅脚本使用，不是字节完全相同的可执行原件。已有来源输入保持不可变。

观察超时在 `finalization.reconnectTimeoutMs` 内重试，取得新结果前保留已有观察。预算用尽后恢复保持受阻，不停止远端工作。实验或发布身份差异立即失败；观察重试不重启 Agent、服务或生成请求。

恢复要求健康服务的 `modelPath` 指向精确的受保护 adapter、推理 Goal 已结束，以及程序发起的服务身份、缺失／错误凭据、模型列表和真实公网生成检查。随后启动原实验的受限完成复验。原阶段、环境、执行及步骤检查继续生效；补录步骤不能替代公网生成。补录 Agent 可引用程序独立恢复证明，核对已修复的服务证据，不重跑训练或推理。

补录验收描述原要求目前是否满足。经过独立核验的关联恢复可使本次评估中的公网服务步骤通过，原来的受阻步骤记录保持不变。恢复自身的 Session 和发布是程序核对的关联字段，不要求重新启动已经失败的原进程。当前服务验收失败仍会阻止通过。复验工具优先展示未闭环步骤编号和关联服务结论，再展示历史记录；原先已完成的步骤无需重复提交。

持久类型确认：[acceptance-recovery.ts](../packages/experiments/src/acceptance-recovery.ts) 在 `$DSH_HOME/aspera-acceptance-recoveries/<experimentId>.v1.json` 定义独立版本 1 记录，绑定两个提交及原结果、计划、Session 和 checkpoint 身份。原工作区 `reports/acceptance-recovery/<operationId>.json` 是另存的不可变证明。Host 重启恢复观察；删除原实验先等待观察结束和已提交写入。关联推理工作保留独立生命周期。原 blocked 结果、发布、步骤、日志、fleet 6、协议 4 和 Session 格式保持不变。

<a id="persistence-and-api"></a>
## 持久记录与接口

持久类型变更确认：[完成证据类型](../packages/experiments/src/completion.ts) 增加独立版本 1 的复验、来源和历史环境记录。`$DSH_HOME/aspera-completion-reviews/<实验ID>.v1.json` 保存操作状态、来源身份、补录条目、原失败及验收时间；配套的操作 JSONL 保存脱敏 Session 事件。标准补录 Session 同时由 DSH 持久保存。本机补录工作区位于 `$DSH_HOME/aspera-run-records/<实验ID>/review/<操作ID>`。远端运行目录仅新增 `completion-reviews-v1/<操作ID>.json`。正常执行在原格式不变的 `executions.jsonl` 旁增加 `execution-sources.v1.jsonl` 和未提交标记 `execution-record-pending.v1.json`。Fleet 存储域 6、提交协议 4、原步骤文件和已发布 Session 格式均不变。

`reviewExperimentCompletion(id)` 确认后台补录请求；`experimentCompletionReviewStatus(id)` 读取保存状态；`cancelExperimentCompletionReview(id)` 停止补录。`experimentCompletionReviewTrace(id, operationId, request)` 提供绑定操作身份的有界本机分页。生成的 Remote 消费者包含这些方法。原 Fleet 持久记录和远端失败结果不变，Host 将独立复验结果投影到状态、筛选及计数。删除先停止并等待补录，再移除本机记录；删除标记拒绝迟到写入。磁盘错误只阻塞复验，不改变训练结果。

补录轨迹分页读取本机原 DSH Session，发布前按事件结构脱敏。旧补录 JSONL 副本损坏不会遮蔽完整 Session；读取不会重启 Agent、重新验收或改写任一历史。原 Session 缺失时，仍可读取通过校验的补录副本。Session 读取失败会明确报错，不替换成看似完整的轨迹。

新发布声明 `completion-evidence-v1`，由清单 `asperaCompletionVersion: 1` 选择。准备阶段在复用控制进程前核对能力。旧实验继续使用原发布，历史读取不升级它。

Session 元数据没有事件总数时，默认轨迹页通过单事件探测定位逻辑末尾。历史分页及后续游标直接读取请求范围。

<a id="validation"></a>
## 验证

`test:worker` 通过正式执行 profile 回放遗漏执行记录、可纠正的完成检查和只启动一次的已结束命令。`test:completion` 使用 CPU 证据运行标准受限补录 Agent 及真实 Remote/Web 页面，覆盖缺失来源受阻、取消、保留原失败、只读历史元数据和补录轨迹。单元测试覆盖归属、摘要、身份冲突和生命周期恢复。本地检查不能证明真实 Linux 挂载隔离、历史远端文件真实性或 GPU/CUDA 验收，这些检查需要原节点可用。
