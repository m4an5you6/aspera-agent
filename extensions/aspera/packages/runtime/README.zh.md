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

派发提供方安装固定发布版本，以私有状态目录调用 `setupWorkerProfile`，再启动 `aspera-worker` profile。其 bundle 为已发布 DSH base 之上的 [worker.patch.yml](worker.patch.yml)。[正式 worker 检查](../../scripts/test-worker.mjs) 无需模型密钥即可验证该入口，Linux 节点执行需要完成 [GPU 验收](../../docs/verification.zh.md#gpu-acceptance)。

通过角色配置选择 `coordinator`、`node`、`planner` 或 `agent`。部署固定控制根目录、令牌、发布和实验 ID。[Config](src/index.ts) 配置轮询、清理、网络探测时限、文件／字节限制及文档访问。[网络探测](src/network-probes.ts) 不分配 GPU，通过接收端身份检查连通性，超时、取消及关闭时清理监听器。节点先隐藏控制目录及其他已登记实验根目录，再绑定当前工作目录。

普通命令不能脱离取消清理。协议 `4` 不限制任务总时长或命令数量，旧分配保留原限制。[存储准备](scripts/storage.mjs) 检查 Linux 挂载、空间、归属和写入能力；未知持久性保持未知。实验 profile 和日志位于所选存储，队列状态及凭据保留在私有目录。缓存／环境变量使用可写工作目录。登记服务保留整组资源，必须通过实际 HTTP 健康检查，失败后不自动重启。[推理网关](src/inference-gateway.ts) 管理显式映射的对外监听和私有服务密钥，详见[服务记录与访问](../../docs/state-and-api.zh.md#logs-outputs-and-services)。节点 profile 设置 `serviceRequestTimeoutMs`（300000）限制上游空闲时间，`serviceRequestBytes`（16777216）限制请求体大小。

`goalContinuationWindow` 是部署设置，默认 `128` 轮；worker patch 通过 `DSH_CLUSTER_GOAL_WINDOW` 配置。续行插件在有限窗口耗尽前通过公开 `Goal.edit` 延长同一 Goal。每次延长都记入日志，并非用户任务预算。连接、探测和模型单次操作超时、循环保护、沙箱和取消仍然生效。

[专属文件清理](src/storage.ts) 在派发端确认资源释放后，仅删除保存的实验工作目录和指定的私有移交文件。清理校验归属标记、实际路径和挂载身份，拒绝嵌套挂载，不遍历目录链接。共享发布、缓存和控制状态保留；中断后从私有清理暂存目录继续。

-----

<a id="understand-the-implementation"></a>
## 了解实现

[phase-model.ts](src/phase-model.ts) 为每个阶段在同一环境中挂载标准 DSH Agent 驱动、独立 LLM 服务及选定的固定版本提供商，并继承 profile 的驱动限制。[phase-agents.ts](src/phase-agents.ts) 与 profile 共享 Agent 发布及发起者跟踪，保留 Goal、记录和取消的正常归属。创建与恢复均校验配置摘要和私有凭据；并行阶段可以为同名提供商使用不同的已保存设置。先释放 Agent，再释放其模型环境。[records.ts](src/records.ts) 分页读取真实阶段事件，节点命令在节点总览日志之外分别保存 stdout/stderr 文件。

<details>
<summary>实现细节</summary>

[transport.ts](src/transport.ts) 为密码和密钥 SSH 命令提供独立 stdout/stderr、退出状态、超时／取消信息及退出确认证据。`remote` 保留成功返回 stdout 的接口；`remoteResult` 返回非零命令结果供诊断，连接失败仍报告错误。已验证程序目录应用于后续所有命令。SSH 断开不能证明远端进程已经结束。

[ssh-host-keys.ts](src/ssh-host-keys.ts) 为本机派发提供首次使用时的公钥探测和加锁登记。认证连接只读取已登记密钥，不登记新身份；委派节点连接继续使用预先安装的私有信任文件。登记在取消后停止，保留无关条目、哈希主机记录和撤销标记。

[cluster.ts](src/cluster.ts) 注册认证控制路由并管理存储生命周期；[cluster-runtime.ts](src/cluster-runtime.ts) 传输和检查输入、启动独立 Agent profile 并观察服务；[cluster-node.ts](src/cluster-node.ts) 串行处理进程申请和清理证据；[cluster-agent.ts](src/cluster-agent.ts) 只在实验 Agent 范围内安装工具。私有目录位于可写工作目录之外。资源及安全检查在接收、命令和文件路径中执行，不发布独立的服务存在检查入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [启动工程](../../README.zh.md)
- [调度提供方接口](../experiments/README.zh.md)
- [数据和接口版本](../../docs/state-and-api.zh.md)

<a id="model-experience"></a>
## 模型体验

Agent 接收已记入日志的固定要求和批准计划。两种角色都能读取随包发布的技能、允许的 HTTPS 文档和声明的输入字节。规划增加计划保存；执行增加受限命令、日志及文件、实测进度、版本及脚本及环境及参数记录、登记服务管理。完成要求每个节点具有执行记录，以及成功结束的命令或健康的所属服务。无法满足要求时持久保存被阻塞的 Goal。

Agent 范围屏蔽全局工具并禁用插件管理层。全自动在提问服务层拒绝人工等待，包括直接请求；半自动通过持久化远端应答提供方接入已有提问服务。无法解决的选择暂停新的 Agent 工具，节点上的受管进程仍可取消。模型提供方的暂时故障重新激活同一 Goal；明确阻塞和不可恢复故障保存终态原因。回复不能修改提交要求或授予权限。[Megatron](skills/megatron/SKILL.md)、[MS-SWIFT](skills/swift/SKILL.md) 和 [Unsloth](skills/unsloth/SKILL.md) 技能要求明确文档版本、独立环境、短运行和实测评估，不承诺参数最优。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 生产执行需要 Linux bubblewrap 和 NVIDIA 设备，网络共享而非隔离。
- 仅支持已移交的 DeepSeek 或 pi-ai 密钥 API 快照；不支持 OAuth 和依赖环境身份的认证。
- 节点重启后结果不明时，需要操作人员核对，不提供强制释放或自动重启训练。
- 多 Agent 算法和 RSI 优化管线由其他扩展实现。

### 开发备注

无。
