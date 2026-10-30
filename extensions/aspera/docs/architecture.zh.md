# Aspera 架构

[English](architecture.md) | 中文

## 概要

Aspera 在 Harness 源码树之外管理实验业务。已发布的 DSH 提供装配、Agent、Goal、Session、凭据、子进程管理和 Web 插槽；Aspera 提供任务记录、调度、远端执行和管理视图。

[完成验收](completion-review.zh.md) 在执行完成和历史复验之间共用同一程序判断。受限补录 Agent 在独立 Session 中记录已有证据，原失败任务与固定发布保持不变。

[阶段验收与实验收尾](finalization.zh.md)使用已有 DSH 工具注册及生命周期扩展点。Agent 选择批准的阶段要求及已有证据，runtime 和 Host 提供方负责命令等待、数值核验及来源绑定的结束判定。不增加编排 Agent，不修改 Agent 主循环。[存储预核验](storage-governance.zh.md#storage-preflight)允许 Agent 选择复用／修复并提出保留策略修订，节点程序负责来源证明、容量准入与部分材料补齐发布。

## 目录

- [组件](#components)
- [架构图](#architecture-diagrams)
- [执行与归属](#execution-and-ownership)
- [扩展位置](#extension-points)

-----

<a id="components"></a>
## 组件

| 包 | 负责内容 | 接入方式 |
| --- | --- | --- |
| `@aspera/experiments` | 版本化请求、整组调度、日志和产物访问 | `ExperimentTable` 和 `ClusterExecutor` |
| `@aspera/runtime` | 持久控制角色、隔离的节点进程、规划及执行 Agent、框架知识 | 已发布的 DSH profile 服务 |
| `@aspera/dispatch` | 服务器登记、输入暂存、发布移交、独立派发 Session 和生成的 Remote | `ExperimentFleet` 和 `FleetDriver` |
| `@aspera/console` | 侧栏页面、表单、记录流和按来源区分的日志游标 | 已发布的 Web 插槽、本地化字典和 Remote 描述 |
| `@aspera/desktop` | 独立窗口、托盘和本机 profile 生命周期 | Electron 及已发布的 `dsh` profile |

接入层维护固定版本发布包的补丁，提供侧栏分组、设置命令和含附件渲染的只读轨迹工厂。工厂使用 DSH 的会话组装器、时间轴、记录列表和详情，消费实验自己的事件源，不创建可编辑 Session，也不导入上游源码路径。官方窗口、普通会话及插件管理仍由 DSH 提供。私有模型配置快照供[阶段环境](../packages/runtime/README.zh.md#understand-the-implementation)使用，公开记录只展示模型摘要。

Host 程序依赖已安装包的类型声明。[types/typert-protocol.d.ts](../types/typert-protocol.d.ts) 中的 Typert 兼容声明只用于生成程序，为分析提供注册元数据。[tsdown.config.ts](../packages/console/tsdown.config.ts) 中的浏览器封装负责兼容 Cordis 的 CommonJS 模块加载及 CSS 插入；公开的客户端类型声明与 JavaScript 打包文件独立生成。

-----

<a id="architecture-diagrams"></a>
## 架构图

管理 Host 负责[本机运行记录](state-and-api.zh.md#local-running-records)，包含独立于页面的同步、持久续读及控制角色停止时的只读 SSH 补拉。页面离线读取已提交副本；远端任务结果及原发布保持原归属。

桌面端与浏览器共用页面和任务服务。持久接管后，远端调度主机管理执行；本机桌面壳不管理 GPU 进程。

执行 Agent 向调度主机上报批准计划的步骤，页面同时读取这些记录和独立的准备／结果验收证据。[步骤进度](state-and-api.zh.md#execution-step-progress)使用独立版本文件，不改变固定的提交、队列或 Session 格式。旧实验保留原远端发布。

准备 Agent 诊断 GPU 授权、控制进程离线及发布 profile 差异，再请求按身份修复。提供方负责探测、资源释放证据、接入限制和复验；按发布隔离的 profile 保留稳定的任务和 Session 运行目录。交接不接受 Agent 的完成声明作为验收。[控制进程就绪](state-and-api.zh.md#controller-readiness)说明原发布兼容和中断恢复。

准备与正式命令共用[执行沙箱](../packages/runtime/README.zh.md#understand-the-implementation)。权限拒绝的原始诊断及兼容方案实测结果返回原准备 Session。Agent 可以请求[专用沙箱修复](../packages/dispatch/README.zh.md#sandbox-compatibility-repair)；仍由程序复验判定就绪，账号权限不足时说明具体云平台操作。

```mermaid
flowchart TB
  subgraph Local[Local management]
    Desktop[Aspera Electron desktop] --> Page[DSH Web + Aspera console]
    Browser[Web browser] --> Page
    Page --> Remote[Typed Remote: RPC + streams]
    Remote --> Fleet[Aspera dispatch: fleet / credentials / Sessions]
    Page --> Trace[Official read-only DSH trajectory]
    Trace --> Remote
    Remote --> Archive[Local archive v1: complete events / logs / steps / metrics]
    Fleet --> Archive
    Archive --> History[Authenticated reads / read-only SSH backfill]
    Remote --> Observations[Versioned observations: events / sources / logs / metrics]
    Fleet --> Management[Peer servers / dated checks / deletion journal]
    Management --> Cleanup[Owned paths only / cleanup receipts / tombstones]
    Management --> Removal[Local deletion / retained remote ownership]
    Fleet --> Models[Private snapshots: preparation / planning / execution]
    Models --> Selection
    Models --> Planner
    Models --> Executor
    Fleet --> Preparation[Local DSH Agent: inspect / configure / repair]
    Preparation --> Checks[Provider verification: versions / execution namespaces]
    Checks --> Inventory[Read-only SSH: mounts / space / interfaces]
    Inventory --> Selection[Restricted Agent: candidate ID + reason]
    Selection --> Placement[Persist placement before directory creation]
    Placement --> Acceptance[Workspace / isolation / credentials / GPU checks]
    Fleet --> InstallationJournal[Preparation v1: original material / budgets / attempts]
    InstallationJournal --> Installer[Detached Linux installer: cache / progress / identity / exit]
    Preparation --> Sources[Probe HTTPS candidate / switch within saved budget]
    Sources --> Installer
    Installer --> Checks
    Installer --> Observations
    Acceptance --> Network[Mutual node identity and network checks]
  end
  subgraph Coordinator[Selected participant: durable coordinator]
    Queue[Aspera experiments: queue / plans / resource groups]
    Planner[Read-only planning Agent]
    Executor[Independent execution Agent]
    Queue --> Planner
    Queue --> Executor
  end
  Network -- SSH: pinned release / inputs / credentials --> Queue
  Queue -- receipt / state / logs / files --> Remote
  subgraph Nodes[Selected Linux GPU nodes]
    NodeA[Node A control profile] --> RunA[Isolated environment / managed commands]
    NodeB[Node B control profile] --> RunB[Isolated environment / managed commands]
    RunA --> Frameworks[Megatron / MS-SWIFT / Unsloth]
    RunB --> Frameworks
    RunA --> Service[Registered inference services]
    External[Platform HTTPS URL] --> Gateway[Authenticated inference gateway]
    Gateway --> Service
  end
  Executor -- Authenticated loopback for coordinator node --> NodeA
  Executor -- SSH tunnel + private HTTP --> NodeB
  RunA --> Observations
  RunB --> Observations
  Frameworks -- metrics / artifacts --> Queue
  Service -- health / resource occupancy --> Queue
```

接管完成原派发 Goal；确认、整组分配、执行和推理服务生命周期仍属于远端实验状态。

```mermaid
sequenceDiagram
  actor User
  participant UI as Desktop / Web page
  participant Fleet as Local dispatch
  participant Queue as Remote coordinator
  participant Agent as Planning / execution Agent
  participant Node as Selected GPU nodes
  User->>UI: Submit Goal, server group and coordinator
  UI->>Fleet: Validate coordinator and cross-coordinator overlaps
  Fleet-->>UI: Preparing; another Goal can be submitted
  Fleet->>Node: Shell-only inspection; Agent configures dependencies
  Fleet->>Fleet: Persist diagnostics; verify tools and executable paths
  Fleet->>Node: Read mounts, space and network interfaces over SSH
  Fleet->>Fleet: Agent selects candidate; persist paths and reason
  Fleet->>Node: Create owned directories; deploy; verify mutual network
  Fleet->>Queue: Fixed release, inputs and private credentials
  Queue->>Queue: Validate and persist admission
  Queue-->>Fleet: Full handover receipt
  Fleet->>Fleet: Persist receipt; finish matching Goal ID + revision
  Fleet-->>UI: Local dispatch complete; remote experiment accepted
  Queue->>Agent: Prepare framework plan without GPU reservation
  Agent-->>Queue: Persist versioned plan
  opt Semi-automatic mode
    UI->>Fleet: Confirm this plan revision
    Fleet->>Queue: Persist confirmation
  end
  Queue->>Queue: FIFO; allocate the entire free server group
  Queue->>Node: Recheck selected mounts, free space and network
  Queue->>Agent: Start independent execution Session + Goal
  Agent->>Node: Prepare experiment environment; run scoped commands
  Node-->>Queue: Logs, metrics, artifacts and service health
  Queue-->>Fleet: Incremental state and file metadata
  Fleet-->>UI: Reconnectable streams; files downloaded on demand
  opt Semi-automatic unresolved decision
    Agent->>Queue: Save question with Session / tool call / revision
    Agent->>Agent: Pause same Goal; managed commands remain monitored
    Queue-->>UI: Saved question and attention count
    UI->>Queue: Persist validated reply
    Queue-->>Agent: Deliver to original call; resume same Goal
  end
  Note over Queue,Node: Accepted work continues after the local application quits
```

管理 profile 串行校验提交。不同调度主机不能管理使用重叠节点的未结束实验，调度节点按实验固定。首次等待确认仍受此登记限制，但不分配 GPU。节点控制服务独立校验执行独占。本机删除使用独立进度及删除标记，并保留未确认的远端归属；可选 SSH 清理要求释放已确认，并验证保存的归属、路径及挂载。

-----

<a id="execution-and-ownership"></a>
## 执行与归属

[存储治理](storage-governance.zh.md) 在准备、执行及管理流程间共用程序拥有的盘点／预算、环境及固定材料服务。Agent 提交限定范围的要求；Host 解析原服务器身份及正式元数据；节点核验历史借用、逐卷预留、保留引用并发布只读内容。这些服务使用已有 DSH 工具和 Session。

节点[受管环境服务](managed-environments.zh.md)负责解释器创建、安装材料核验、不可变共享包发布和引用限定回收。执行 Agent 通过已记录工具选择依赖，来源构建仍限定在私有暂存区；命令与服务通过只读挂载保护共享内容。本机独立保存带时间的空间观察，不改变实验结果或远端发布身份。

Host 管理用户中断及独立持久回执。可见实验、已删除任务与准备修复共用[远端任务收尾](state-and-api.zh.md#remote-task-settlement)。最小归属记录在本机删除后保留；原认证接口或账号内 SSH 核对全部原节点后才能释放占用。待开始任务和退出未确认的任务继续保留占用。准备的控制进程修复在启动前使用同一服务，交接前仍需独立复验。

管理 Host 使用所选模型和现有 Session 启动标准 DSH 准备 Agent。仅依赖 Shell 的探测先于依赖 Node 的清单读取。限定服务器的 SSH 工具使用登录账号权限配置依赖，Node 和 pnpm 版本来自发布要求。Host 保存程序路径、节点阶段及诊断，并复验每次修复。同一 Agent 选择实际存储候选并说明理由，手动目录优先，创建目录前保存选择。准备、上传及启动时复查挂载身份、归属、写入能力和空间。沙箱隔离、凭据隐藏、CUDA 和双向网络证明共同决定能否交接；内核或设备权限限制明确阻塞，模型声明不能免除检查。

控制状态、队列和凭据位于登录用户固定的私有控制目录。发布文件及每个实验的输入、Agent 状态、日志、缓存、环境、临时文件和产物使用选中磁盘。节点工具只暴露获准设备，隐藏控制目录与已登记的实验存储根目录，仅将当前工作目录挂载为可写。框架缓存保存在该目录，[执行临时路径](../packages/runtime/README.zh.md#understand-the-implementation)继续使用选中磁盘。网络仍共享以便下载和训练，此处不提供网络隔离。

登记的推理进程归节点控制服务管理。Goal 结束或浏览器断线后，服务继续运行并占用整组资源。调度服务重启会恢复服务观察；训练结果或节点进程身份不明时标记为中断，保留未确认的资源占用。取消只有在每个节点确认清理后才释放整组资源。

每个发布版本固定 DSH/扩展版本、包文件和冻结的生产依赖锁文件。新部署使用新目录，profile 身份阻止 worker 状态目录被绑定到另一发布版本。正在运行的控制进程直接复用，不被替换。控制协议不兼容的升级需等待旧任务结束、旧控制进程停止后再启用。

运行时通过公开 Goal 服务延长有限轮数窗口，保留同一执行 Session 和 Goal。全自动拒绝人工等待；半自动持久保存问题，暂停新的 Agent 操作，并将保存的回复交给原工具调用。控制台独立于页面选择刷新共用待处理数量，桌面校验计数后更新 Windows 叠加图标和隐藏窗口时的托盘标识。已发布的 [DSH 上下文服务](../packages/runtime/README.zh.md#use-this-package)在各阶段的私有模型环境中执行压缩；单次输出上限先在原 Goal 中有限纠正，之后才写入受阻终态结果。

-----

<a id="extension-points"></a>
## 扩展位置

`aspera-single` 是执行预设。协作算法由 `ClusterExecutor` 或运行时协调插件实现，预设选择角色和能力。其他拓扑、消息路由、评价、轮次和停止规则可以使用 DSH 子 Agent，无需修改 Agent 循环。替换循环需要独立的兼容验证。

RSI 管线可以使用固定提交信息、输入摘要、框架执行记录、模型产物、发布身份和实际评估。候选数据、模型及 Harness 版本与当前发布版本分开，独立评估后再发布，并保留原版本以便回滚。本工程提供记录与执行，不包含 RSI 优化器或多 Agent 博弈算法。

版本化方式见[状态与接口归属](state-and-api.zh.md)，当前验收范围见[验证说明](verification.zh.md)。
