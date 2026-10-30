# 阶段验收与实验收尾

[English](finalization.md) | 中文

<a id="summary"></a>
## 摘要

现有 DSH 执行 Agent 选择批准要求及证据，Aspera 执行命令等待、数值检查和结束判定。不增加编排 Agent，不修改 Agent 主循环。历史复验只读取已有文件，不能重新训练、评估或生成推理结果。

<a id="table-of-contents"></a>
## 目录

- [批准的阶段](#approved-stages)
- [命令等待](#command-waiting)
- [有限诊断](#bounded-diagnostics)
- [结束判定](#finish-decisions)
- [历史复验](#historical-review)
- [记录与兼容](#records-and-compatibility)

<a id="approved-stages"></a>
## 批准的阶段

计划可以包含结构化 `stages`。Transformers/ms-swift/PEFT 计划在批准前必须提供阶段。每个阶段绑定计划步骤、累计起止步数、新增优化器步数、指标范围与记录频率、scheduler 恢复方式／总长度／warmup、明确的样本计数依据及可选结果要求。允许区间内的取值在批准前固定。`30 + 200 = 230` 表示新增 200 步并结束于累计 230 步，不要求新增 230 条指标。稀疏日志按声明的优化器步检查，相同重复记录去重，冲突尝试被拒绝。

`register_experiment_stage` 在启动前将批准要求绑定到节点、尝试、命令及工作区相对路径中的生效参数、trainer state 和结果。程序独立读取、计算参数摘要，并在启动绑定命令前再次检查。`verify_experiment_stage` 核验原命令成功退出与释放、checkpoint 起止、生效参数、指标覆盖、scheduler 及实际样本记录。继续原 scheduler 时沿用原 warmup 和总长度；重启调度必须使用批准的 restart 模式。缺失、截断或不支持的来源保持未核验。Shell 退出 0 和 Agent checklist 不能替代程序检查。

确认失败并释放的命令可以通过 `register_experiment_stage(previousAttemptId=...)` 登记后继尝试。Agent 选择新的尝试与命令 ID，以及独立的 trainer state、指标和结果路径。程序先核对原命令结果，再给出重试身份或路径指引。程序保留原批准要求及 resume/optimizer/scheduler/RNG 来源，重新检查生效参数，每个前序最多原子发布一个后继。初始登记与失败核验记录保持完整。重复请求返回已提交尝试，并发或迟到请求不能替换它。运行中、已成功和退出未确认的命令不具备重试资格。`parameters` 指向已经存在的 JSON 文件，其余路径指向该尝试将产生的文件，不接受内联 JSON 作为文件名。

结构化评估和重载证据必须提供实际样本数、有限 loss 和非空回答，并标识登记的训练 checkpoint。续训还要求独立计算原 optimizer、scheduler 及 RNG 文件摘要、核对非仅权重恢复的生效配置、checkpoint 起止、学习率数值连续性和样本顺序证据。不执行二进制 checkpoint 代码。声明产物路径必须对应有归属且非空的文件。解析器支持有读取上限的 Transformers trainer state、JSON 和 JSONL 证据；不支持的格式返回明确诊断，不能推断通过。

结构化来源同时列入 `requiredFiles` 时仍完整读取正文；仅作产物检查的二进制来源只读取元数据。重载回答支持 JSON 数组、结果对象及 JSONL。每条回答必须直接标识登记的 checkpoint 与尝试，或继承外层结果对象中的身份；回答中的冲突身份被拒绝。

登记的 trainer-state 副本可以存放在日志目录。只有批准的原生终点状态与该副本的完整字节、大小及 SHA-256 一致，结果才能关联该恢复点；日志目录不是 checkpoint。保留实际加载的 adapter 路径和原结果。启动前的中间恢复点保存检查也依据声明的原生输出目录，不依赖副本位置。

登记工具在启动前说明支持的证据字段：指标使用 `step`/`global_step`（或格式化的 `global_step/max_steps`）、`loss` 和 `learning_rate`；评估使用 `n`/`eval_samples`/`num_samples` 及 `eval_loss`；回答使用 `response`/`output`/`generated_text`。结果通过 `adapter_path`/`checkpoint`/`model_checkpoint` 标识来源，`attempt_id`/`phase` 与 `attemptLabel` 一致。不匹配时返回具体文件、期望标签、实际值及独立的登记尝试 ID；超长或无效值仅作摘要，不改变验收。Agent 整理结构化记录时保留原始日志。续训登记在发布前读取原 `resumeState` JSON，核对其 `global_step` 与批准起点；目录、不可读来源或错误步数在请求仍可修正时被拒绝。

批准要求包含评估、推理、基座对照或样本检查时，登记前必须提供对应文件名。未来产物此时可以尚不存在，但缺失引用不能成为不可变尝试。Agent 选择路径，在启动训练前修正被拒绝的请求。

声明的原生 `checkpoint-N/trainer_state.json` 文件完整读取，其累计步数必须等于 N。登记输出目录中的中间恢复点要求明确的整数步保存间隔，必须能产生该恢复点，保留数量必须使其留到最终 checkpoint。续训使用原生 `TrainerState.save_steps`，它可能覆盖新命令的间隔；初始训练登记还会检查批准的后续阶段继承该间隔后能否满足保存要求。不支持的回调声明不能替代启动前检查。Agent 在训练前选择兼容参数，程序不修改 checkpoint，也不接受其他步数的 checkpoint 改名充数。

原始评估对象在 `mode: "eval"` 时可使用 `evaluatedSamples` 和 `meanLossPerSupervisedToken`；明确标记 loss 非有限数时拒绝。生成对象可将原始回答保存在 `rows` 中，通过 `adapterPath` 或 `adapter` 标识 checkpoint。这些字段别名不放宽数量、尝试身份或 checkpoint 检查，也不要求改写原始证据。

<a id="command-waiting"></a>
## 命令等待

批准的 `requiredFiles` 通过 `trainer_state.json` 和模型或 adapter 权重标识原生恢复文件组。程序在训练命令启动前登记这些文件组。命令成功退出且进程释放后，后续普通命令和推理服务将其只读挂载。保留记录重新核对工作区归属、实际挂载身份、链接、目录和文件身份；证据缺失或变化时阻止修改，只读诊断仍可使用。登记的 checkpoint 产生进程要求独占本节点的可写操作；多节点命令组仍先启动参与方再等待。

格式或漏录问题不授权重跑已成功的训练命令。Agent 保留 checkpoint 与原始日志，在原登记路径整理正确的结构化证据，执行评估／重载，再请求核验。程序不会代替 Agent 生成训练结果。

命令结果返回用于 `read_experiment_file` 的 `logs.stdout` 和 `logs.stderr` 引用。传入 `command_id`、`stream`、`offset` 及返回的 `generation`；命令流不能与 `path` 同时选择。诊断输出位于只读工作区之外，不会默认生成 `logs/<run_id>.log`。`finalization.commandOutputBytes` 默认每页 8192 字节。读取核对实验、节点、命令及输出流身份，将不完整的 UTF-8 字节留待下一页，并明确标记输出缺失。

`run_experiment_command` 等待原命令真实终态及清理确认。等待期间保持 DSH 工具独占属性，周期性的轻量状态读取不会触发下一次模型请求。日志归档和页面刷新独立运行。空读取或文件 EOF 只表示当前没有更多字节。

等待记录将命令 ID 绑定到 SHA-256 及用途（`run` 或 `diagnostic`）。重试内容变化时，在替换原等待记录前拒绝。经过认证的节点状态独立返回原摘要和用途；被拒绝的提交不能沿用旧命令的成功退出。身份缺失时保持未确认。只读等待保留已保存的请求身份，命令组逐一核对原成员。

`run_experiment_command_group` 先提交全部授权成员再等待，支持分布式 rendezvous。经过认证且身份匹配的 `not-started` 回执立即结束被拒绝成员的等待；停止已启动或状态未明的其他成员并核验退出。其他 HTTP 错误不能证明命令从未启动。传输回复丢失时核对原成员，不启动替代命令。同一操作 ID 保留原请求。常驻推理继续使用专用服务工具。

`finalization` 配置默认为每秒轮询、单次读取 30 秒、连续连接恢复预算 60 秒，以及两次无证据理由纠正。已有明确命令期限继续生效；这些设置不增加训练总时限。取消观察不能证明远端退出，未决退出继续保留资源保护。等待不持有服务器全局锁。

<a id="bounded-diagnostics"></a>
## 有限诊断

`run_experiment_diagnostic` 执行 Agent 自选命令，工作目录只读、不授予 GPU、隐藏凭据和控制目录，临时写入限定在有容量上限的私有空间内。已验证环境／材料只读挂载；无效授权会被省略并明确返回诊断，仍可检查基础系统。该工具不要求训练容量准入，也不能满足训练阶段验收。固定位置归属核验和真实退出确认仍然生效。`finalization.diagnostics` 默认设置为 `timeoutMs: 60000`、`temporaryBytes: 67108864`、`logBytes: 8388608`、`evidenceFileBytes: 1048576`、`evidenceTotalBytes: 16777216`；bubblewrap 必须支持 `--size`。达到时间或日志上限后停止受管进程并保留具体原因。日志上限包含原始 stdout/stderr 和序列化后的观察记录。

准备阶段在交接前实际测试诊断启动并测量临时文件系统上限。不支持 `--size` 时，在 `diagnostic-isolation` 返回真实 stderr；准备 Agent 必须配置账号拥有的兼容 bubblewrap，再请求复验。程序不会默默移除上限。

`write_experiment_evidence` 将有限大小的 UTF-8 文本或 JSON 写入 `configs/`、`reports/`、`artifacts/diagnostics/`。程序核验目录描述符，拒绝符号链接及已有的不同内容，相同操作恢复时不重复写入。证据配额包含待完成写入。写入回执证明字节和文件身份，不证明 Agent 陈述属实。

<a id="finish-decisions"></a>
## 结束判定

完成检查、finish 请求和最终收尾共用逐节点执行、步骤、环境、命令及阶段检查。收尾命令仍运行时继续等待。完成请求缺少记录时返回补录方法，Goal 保持活动。受阻请求可以保留未核验的 Agent 解释，不虚构训练证据。缺少阶段登记、执行条目和步骤报告不能独立证明材料、网络或容量故障。提交结果前重新核对来源身份与命令事实。

`reason: "requirement"` 的 `requirement_evidence_json` 选择 `{serverId,kind,id}` 引用，kind 为 `storage-plan`、`material-request` 或 `material-operation`。程序重读原回执，核对实验、服务器、批准计划修订和 Session 关联。已核验判定仅引用对应观察：节点清单请求失败不能证明 Host 获取或历史复用不可能。没有匹配证据时，受阻结果标记 `verified: false`。资源释放仍依赖真实进程退出和清理回执。

预算理由区分实际输入超限错误、单次输出 `max-tokens`、程序配置预算、压缩失败和 Agent 自述。只有匹配的实际 Session 事件能确认预算故障。token 总量与模型声明窗口不能单独证明耗尽。无证据的预算和条件阻塞上报先获得 `finalization.reasonCorrections` 次机会，默认两次，读取已有诊断并选择获准的恢复；用尽后记录为 Agent 工作未完成，保留原证据及未决占用。单次输出截断先在原 Goal 和 Session 中记录缩短回答的指引并继续，`finalization.outputTokenCorrections` 默认允许连续恢复两次，收到工具结果后重新计数。程序不会自动重放命令、安装或训练。

<a id="historical-review"></a>
## 历史复验

[完成证据复验](completion-review.zh.md) 保留原结果。已释放的 blocked 实验还必须具备明确的原结构化要求或程序识别的显式旧续训要求、原 blocked finish／Goal 变更、达到批准终点的 checkpoint、非空 adapter，以及全部节点原命令退出与释放证据。具备资格不代表通过。

受限补录 Agent 使用原模型和独立 Session，可以登记历史阶段、请求数值核验，以及按当前 assessment 版本提交引用实际来源的步骤补录。原步骤记录不修改。不适用报告必须对应原计划明确声明且程序确认未触发的条件步骤。发布独立、带时间的通过回执前，必须重新通过文件、环境、结果及释放检查。原文件不可达时继续待验，即使本机轨迹可读。

<a id="records-and-compatibility"></a>
## 记录与兼容

环境失败可以使用 `environment-operation` 要求证据。节点核对原计划与 Session 关联、失败回执、进程退出及准入释放。所得观测仅说明该操作；历史候选被拒绝不能证明所有修复、材料来源或容量方案均不可用。完成记录缺失仍是另一项条件。

持久化类型确认：`command-admissions-0.1.3` 与 `diagnostic-evidence-0.1.3` 使用独立第 1 版、业务格式 0.1.3 记录。命令结果增加可选 `purpose: "diagnostic"`。等待记录增加可选拒绝回执、原始提交错误、独立观察错误及固定重连截止时间，重复调用与重启保留该截止时间。匹配实验／节点／命令／内容的拒绝回执立即返回，不再等待不存在的进程。身份缺失或传输错误仍保留退出未知状态与分配保护。旧等待记录保持可读。

持久类型变更确认：[阶段定义](../packages/experiments/src/stage-requirements.ts) 为计划增加可选结构化阶段与条件步骤，旧计划继续可读。[收尾类型](../packages/experiments/src/finalization.ts) 定义独立版本 1：原私有运行目录中的 `stage-acceptance-v1` 登记／验收、`command-waits-v1` 命令等待、`command-groups-v1` 固定组请求和 `finish-decision.v1.json`。复验新增记录位于本机原回执旁的 `<experimentId>.assessment-v1.json`，以及远端 `completion-assessments-v1/<operationId>.json`。原结果、执行条目及步骤文件保留。

持久类型变更确认：`StageRegistrationInput` 增加可选 `previousAttemptId`，已保存的版本 1 登记字段保持不变。独立版本 1 的 `StageAttemptTransition` 位于 `stage-attempts-v1/<serverId>_<stageId>/<previousAttemptId>.json`。每个不可变前序槽保存失败且已释放的命令、原失败核验及后继。现有实验专属归档和清理覆盖这些记录。协议 4、fleet 6 与 Session 格式保持不变。

要求关联使用独立的 `version: 1`、`formatVersion: "0.1.1"` 操作记录；结束判定增加可选 `requirementEvidence`。原判定继续可读且不改写。`targeted-materials-0.1.1` 能力提供证据接口，资源更新不会将这些操作发送给旧固定发布。

`experimentCompletionAssessment(id)` 读取独立历史核验。`experimentFinalizationStatus(id)` 通过协议 4 认证接口或程序拥有的只读 SSH 后备读取轻量私有记录，在 `$DSH_HOME/aspera-run-records/<experimentId>/finalization.v1.json` 保留远端错误和原观察时间。删除及退出先停止并等待读取，再清理副本；迟到回复不能恢复记录。终态实验和离线观察停止动画。本机存储域 6、提交协议 4 及 Session 格式不变，全部生成 Remote 消费者同步更新。

新发布声明 `asperaFinalizationVersion: 2`，准备及控制进程复用要求 `experiment-finalization-v2`。旧实验继续使用固定发布，Host 历史复验不升级原发布。实验专属清理包含新增私有记录。参见[升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-finalization/guide.zh.md)。

`asperaStageEvidenceVersion: 4` 要求控制进程复用前核对 `stage-evidence-reading-v1`、`stage-evidence-reading-v2`、`stage-checkpoint-evidence-v3` 和 `stage-checkpoint-evidence-v4`。版本 1 的证据字段和声明 1–3 的历史清单仍可读取。保存配置及原生状态检查不改写登记、来源或结果。公网服务使用[程序拥有的公网验收](public-inference.zh.md)。

`asperaEnvironmentTools.commandOutputVersion: 1` 要求控制进程具备 `command-output-v1` 后才能复用。`ProcessLogRequest.limit` 是可选的传输分页字段；命令输出引用继续作为普通工具结果记入日志。新增 `finalization.commandOutputBytes` 设置在 profile 加载时解析。Session、提交、命令等待及输出流文件格式保持不变。

持久类型变更确认：格式 `0.1.4` 的命令等待增加可选 `requestHash` 和 `purpose`；解析器继续读取旧等待记录，不补造缺失身份。新的认证状态回复增加原命令摘要。`asperaEnvironmentTools.commandIdentityVersion: 1` 要求控制进程复用前具备 `command-wait-identity-v1`。提交协议 4、fleet 6 和 Session 格式保持不变。
