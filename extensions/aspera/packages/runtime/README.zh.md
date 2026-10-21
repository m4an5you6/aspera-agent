---
description: "运行持久的 Aspera 节点和调度 profile，以及具有通用框架知识的受限规划或执行 Agent。"
kind: "package-bundle"
---

# @aspera/runtime

[English](README.md) | 中文

## 概要

使实验控制、执行 Agent 及受管训练和推理进程具有独立生命周期。节点归属单个实验，命令受文件系统及 GPU 权限限制，并保存进程清理证据。只读工具准备计划，再由单 Agent 执行批准的要求。框架技能指导版本选择和短验证，不包含各框架的参数适配器。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

派发提供方安装固定发布版本，通过 `setupWorkerProfile` 和封存的 setup 入口初始化 profile。常驻控制进程在稳定角色运行目录中使用 `aspera-worker-<deploymentId>`，实验 Agent 在私有运行目录中使用 `aspera-worker`。[控制进程恢复](../../docs/state-and-api.zh.md#controller-readiness)跨发布保留原任务和 Session 存储。bundle 为已发布 DSH base 之上的 [worker.patch.yml](worker.patch.yml)。[正式 worker 检查](../../scripts/test-worker.mjs)无需模型密钥即可验证 worker 入口，Linux 节点执行需要完成 [GPU 验收](../../docs/verification.zh.md#gpu-acceptance)。

通过角色配置选择 `coordinator`、`node`、`planner` 或 `agent`。部署固定控制根目录、令牌、发布和实验 ID。[Config](src/index.ts) 配置轮询、清理、网络探测时限、文件／字节限制及文档访问。[网络探测](src/network-probes.ts) 不分配 GPU，通过接收端身份检查连通性，超时、取消及关闭时清理监听器。节点先隐藏控制目录及其他已登记实验根目录，再绑定当前工作目录。

控制健康接口通过 `controller-readiness-v1` 提供启动身份、规范化授权和当前占用。经过认证的 `controller-maintenance-v1` 操作原子拒绝仍被占用的角色，并暂停接受新任务。`gpuSnapshot` 保存启动时的 UUID 与设备映射；节点分配将其与当前 NVIDIA XML 身份及可访问的字符设备比较。仅有 HTTP 健康响应不能授权复用。[控制进程准备](../../docs/state-and-api.zh.md#controller-readiness) 定义修复归属、旧进程检查和独立验收。

普通命令不能脱离取消清理。协议 `4` 不限制任务总时长或命令数量，旧分配保留原限制。[存储准备](scripts/storage.mjs) 检查 Linux 挂载、空间、归属和写入能力；未知持久性保持未知。实验 profile 和日志位于所选存储，队列状态及凭据保留在私有目录。缓存／环境变量使用可写工作目录。登记服务保留整组资源，必须通过实际 HTTP 健康检查，失败后不自动重启。[推理网关](src/inference-gateway.ts) 管理显式映射的对外监听和私有服务密钥，详见[服务记录与访问](../../docs/state-and-api.zh.md#logs-outputs-and-services)。节点 profile 设置 `serviceRequestTimeoutMs`（300000）限制上游空闲时间，`serviceRequestBytes`（16777216）限制请求体大小。

`goalContinuationWindow` 是部署设置，默认 `128` 轮；worker patch 通过 `DSH_CLUSTER_GOAL_WINDOW` 配置。续行插件在有限窗口耗尽前通过公开 `Goal.edit` 延长同一 Goal。每次延长都记入日志，并非用户任务预算。连接、探测和模型单次操作超时、循环保护、沙箱和取消仍然生效。

`agentContext.compaction` 和 `agentContext.pruning` 配置已发布 DSH 的基础压缩器及工具结果裁剪器，沿用各自经过校验的默认值。每个创建或恢复的阶段 Agent 都在其私有 LLM 提供商环境中挂载这两个服务；profile 的 token 计量服务保留共用投影。摘要使用实验保存的阶段提供商与模型，包括匹配的模型策略覆盖项；冲突的摘要配置在创建 Agent 前报错。worker 根级压缩禁用。Host 保留外层压缩器时，阶段所属的 Cordis 事件过滤只允许该 Agent 的 DSH 基础压缩器处理其事件，普通对话保持原有行为。摘要和裁剪事件保留在原 Session 中，取消会中止进行中的摘要请求，不发布部分摘要。

[专属文件清理](src/storage.ts) 在派发端确认资源释放后，仅删除保存的实验工作目录和指定的私有移交文件。清理校验归属标记、实际路径和挂载身份，拒绝嵌套挂载，不遍历目录链接。共享发布、缓存和控制状态保留；中断后从私有清理暂存目录继续。可选取消信号关闭进行中的 SSH 命令，本机记录删除无需等待该命令。

-----

<a id="understand-the-implementation"></a>
## 了解实现

[owned-command.ts](src/owned-command.ts) 在共享准入锁内保存 Linux 命令与 Agent 进程身份，然后使用原沙箱参数或受支持的 DSH profile 启动。实验中断标记拒绝新增启动，原节点释放接口继续用于清理。离线信号投递要求 Linux Python 支持 pidfd；身份不可用或构建不支持时保留分配。[受控中断](../../docs/state-and-api.zh.md#experiment-interruption)说明回执字段与释放语义。

[observations.ts](src/observations.ts) 管理独立第 1 代来源目录及有界、脱敏的输出记录。安装导入保留远端序号和采集时间，对重复页去重，包括较长的末尾记录。[metrics.ts](src/metrics.ts) 采集节点实际资源，上报的训练值保存为独立序列。调度主机访问自身固定节点时使用带认证的本机回环，其他节点仍使用 SSH。读取不释放分配，也不重启失败任务。参见[观测配置与兼容](../../docs/state-and-api.zh.md#logs-outputs-and-services)。

[phase-model.ts](src/phase-model.ts) 为每个阶段在同一环境中挂载标准 DSH Agent 驱动、独立 LLM 服务及选定的固定版本提供商，并继承 profile 的驱动限制。[phase-agents.ts](src/phase-agents.ts) 与 profile 共享 Agent 发布及发起者跟踪，保留 Goal、记录和取消的正常归属。创建与恢复均校验配置摘要和私有凭据；并行阶段可以为同名提供商使用不同的已保存设置。先释放 Agent，再释放其模型环境。[records.ts](src/records.ts) 分页读取真实阶段事件，节点命令在节点总览日志之外分别保存 stdout/stderr 文件。

[model-configuration.ts](src/model-configuration.ts) 将已解析的 DeepSeek 设置转换为可复用的插件输入，并读取已校验哈希的旧快照。提供商的原生校验继续生效。[快照兼容性](../../docs/state-and-api.zh.md#persistent-ownership) 说明持久字段与恢复规则。

<details>
<summary>实现细节</summary>

[experiment-sandbox.ts](src/experiment-sandbox.ts)管理准备与正式命令共用的 Linux 启动参数：用户／PID／IPC／UTS 命名空间、私有 `/proc`、移除全部能力、限定设备授权、隐藏的控制／存储目录、清空的环境及工作目录内缓存。发布目录在沙箱内不可见，因此准备探测以内联程序执行。命名空间或 proc 挂载被拒绝时，以原始诊断阻止接入；[专用兼容修复](../dispatch/README.zh.md#sandbox-compatibility-repair)保留这些隔离。受控进程清理在需要时从 TERM 升级到 KILL，包括命名空间监督进程忽略 TERM 的启动器。

[transport.ts](src/transport.ts) 为密码和密钥 SSH 命令提供独立 stdout/stderr、退出状态、超时／取消信息及退出确认证据。`remote` 保留成功返回 stdout 的接口；`remoteResult` 返回非零命令结果供诊断，连接失败仍报告错误。已验证程序目录应用于后续所有命令。SSH 断开不能证明远端进程已经结束。

密码命令、上传和接收端请求可按已解析的[连接策略](src/ssh-connection.ts)在认证前重连。每个失败客户端关闭后才建立下一个连接；尝试和等待共用一次操作的截止时间及取消信号。主机密钥和认证失败直接结束。认证后发生命令通道或接收端错误时，不自动重试，缺少远端退出证据的结果仍为未确认。密钥 OpenSSH 操作保留原退出回执行为。

[ssh-host-keys.ts](src/ssh-host-keys.ts) 为本机派发提供首次使用时的公钥探测和加锁登记。探测使用内置 SSH 客户端，在认证前断开，不需要 `ssh-keyscan` 进程，并遵守调用方的取消和截止时间。认证连接只读取已登记密钥，不登记新身份；委派节点连接继续使用预先安装的私有信任文件。登记在取消后停止，保留无关条目、哈希主机记录和撤销标记。

[cluster.ts](src/cluster.ts) 注册认证控制路由并管理存储生命周期；[cluster-runtime.ts](src/cluster-runtime.ts) 传输和检查输入、启动独立 Agent profile 并观察服务；[cluster-node.ts](src/cluster-node.ts) 串行处理进程申请和清理证据；[cluster-agent.ts](src/cluster-agent.ts) 只在实验 Agent 范围内安装工具。私有目录位于可写工作目录之外。资源及安全检查在接收、命令和文件路径中执行，不发布独立的服务存在检查入口。

[节点记录归属](../../docs/state-and-api.zh.md#persistent-ownership) 定义执行、日志和服务清理共用的命令键。节点生命周期测试使用已发布 JSON 后端，在模拟重启后重新读取持久化记录，并保留未确认进程的归属。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [启动工程](../../README.zh.md)
- [调度提供方接口](../experiments/README.zh.md)
- [数据和接口版本](../../docs/state-and-api.zh.md)

<a id="model-experience"></a>
## 模型体验

环境恢复保留原回执，返回独立代次及清理诊断；Agent 恢复后必须请求程序重新验收。普通临时删除失败保留已验收环境，挂载或身份错误仍阻塞；命令和服务沙箱隐藏待清理操作目录。

`inspect_experiment_environment` 读取分配节点限定的环境及复用记录；`prepare_experiment_environment` 在固定 uv 安装、验收或文件分离前强制核对复用和空间。`recover_experiment_environment` 核对原启动/进程证据，`preview_experiment_cache_cleanup` 与 `cleanup_experiment_cache` 共用程序管理的清理服务。普通命令和服务通过只读挂载加载已验证内容。[受管环境](../../docs/managed-environments.zh.md)说明材料保留、专属入口、链接、恢复及空间统计，`managedEnvironments` 配置安装与观察上限。

[environment-operation.ts](src/environment-operation.ts) 通过认证的轻量状态读取，让现有串行安装工具持续等待。节点保存原期限，独立核验退出和准入释放。`create` 合并直接依赖要求，`install` 明确替换要求。专属固定 pip 工具环境负责解析及下载依赖，不向训练环境填入种子包。结构化文件冲突阻止更换操作 ID 后无条件重试。固定发布声明 `managed-environment-install-v3`，Agent 主循环保持不变。

Agent 接收已记入日志的固定要求和批准计划。两种角色都能读取随包发布的技能、允许的 HTTPS 文档和声明的输入字节。规划增加计划保存；执行增加受限命令、日志及文件、实测进度、版本及脚本及环境及参数记录、登记服务管理。完成要求具有执行记录、已完成的步骤上报，以及每个节点上成功结束的命令或健康的所属服务。无法满足要求时持久保存被阻塞的 Goal。

执行通过 `get_experiment_execution_progress` 和 `report_experiment_step` 将批准的步骤上报为进行中、已完成或受阻。程序记录执行身份及调用时间。记录版本冲突返回诊断和最新记录，Agent 修正上报而不重跑已结束命令；遗漏步骤上报时，Goal 保持活动直至补齐。上报不能代替命令、节点或结果的独立验收。[步骤持久化](../../docs/state-and-api.zh.md#execution-step-progress)定义归属和迟到消息的拒绝规则。

Agent 范围屏蔽全局工具并禁用插件管理层。全自动在提问服务层拒绝人工等待，包括直接请求；半自动通过持久化远端应答提供方接入已有提问服务。无法解决的选择暂停新的 Agent 工具，节点上的受管进程仍可取消。模型提供方的暂时故障重新激活同一 Goal；明确阻塞和不可恢复故障保存终态原因。回复不能修改提交要求或授予权限。[Megatron](skills/megatron/SKILL.md)、[MS-SWIFT](skills/swift/SKILL.md) 和 [Unsloth](skills/unsloth/SKILL.md) 技能要求明确文档版本、独立环境、短运行和实测评估，不承诺参数最优。

规划或执行回合在完成前以 `max-tokens` 结束时，将 Goal 以 `aspera-model-token-limit` 标记受阻，落盘 Session 并写入 worker 终态结果。调度端沿用已有释放检查核对所属命令及服务；该结果不重跑命令。[正式 worker 回放](../../scripts/test-worker.mjs)覆盖真实压缩后继续调用工具，以及已结束命令仅启动一次时的 token 上限退出。

[完成验收](../../docs/completion-review.zh.md) 说明检查工具、完成工具和 worker 最终收尾共用的检查。缺少节点证据时，原 Goal 保持活动以补录已有结果，不重复训练。

[阶段验收与实验收尾](../../docs/finalization.zh.md) 定义批准的优化器步数口径、独占命令／命令组等待、来源绑定检查与预算证据。`finalization` 配置负责轮询、读取／重连限制、证据大小及纠正次数，不增加训练总时限。这些工具使用已有 DSH 注册及生命周期扩展点。

[存储治理](../../docs/storage-governance.zh.md) 提供共用的账号视角盘点、历史环境借用、逐卷预留及不可变模型／数据获取。限定范围的工具使用程序生成的候选及原操作；命令、服务与完成验收消费者核验只读授权。文件内容锁协调跨版本获取。运行时保留原环境和失败证据。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 生产执行需要 Linux bubblewrap 和 NVIDIA 设备，网络共享而非隔离。
- 仅支持已移交的 DeepSeek 或 pi-ai 密钥 API 快照；不支持 OAuth 和依赖环境身份的认证。
- 节点重启后结果不明时，需要操作人员核对，不提供强制释放或自动重启训练。
- 多 Agent 算法和 RSI 优化管线由其他扩展实现。

### 开发备注

无。
