# 状态与接口

[English](state-and-api.md) | 中文

## 概要

[存储持久记录与接口](storage-governance.zh.md#records-and-compatibility) 确认独立版本 1 的索引、借用、预留及材料操作、观察／清理可选字段，以及 `experimentStoragePlan` 和 `refreshExperimentStorage`。生成的 Host／Client 消费者同步更新；已有 fleet、Session 和原固定发布数据不变。

[完成证据与历史复验](completion-review.zh.md) 说明补录状态、来源及历史环境类型、独立版本 1 持久记录变更确认及生成的复验 Remote 接口。原始失败回执不变。

Aspera 扩展 `0.1.1` 使用远端协议 `4` 和本地 fleet 存储第 `6` 代，兼容读取已发布记录时保留原身份、摘要和限制。生成的 DSH Remote 使用 `aspera` 命名空间，认证控制请求使用 `/aspera/v4`。字段及品牌 ID 见[协议](../packages/experiments/src/cluster-protocol.ts)、[存储探测定义](../packages/experiments/src/storage-protocol.ts)和[派发类型](../packages/dispatch/src/types.ts)。

## 目录

- [持久归属](#persistent-ownership)
- [回执与 Goal](#receipts-and-goals)
- [控制进程就绪与恢复](#controller-readiness)
- [接口使用方](#api-consumers)
- [执行步骤进度](#execution-step-progress)
- [受控中断](#experiment-interruption)
- [远端任务收尾](#remote-task-settlement)
- [本机运行记录](#local-running-records)
- [日志、产物和服务](#logs-outputs-and-services)

-----

<a id="persistent-ownership"></a>
## 持久归属

| 归属方 | 存储域/版本 | 持久记录 |
| --- | --- | --- |
| 管理 Host | `aspera_fleet` / `6` | 服务器偏好、SSH／环境探测、已验证程序路径、节点阶段、未决命令、存储选择、要求和回执 |
| 远端调度主机 | `aspera_queue` / `4` | 接收顺序、计划、确认、分配、执行身份、进度和服务 |
| 节点控制服务 | `aspera_node` / `4` | 节点分配、命令身份、清理证据和登记的服务状态 |
| 实验观测目录 | `observations-v1` / `1` | 来源归属、脱敏输出流及资源／训练指标历史 |
| 管理通知 | `aspera_error_notices` / `1` | 首次显示的指纹与时间，独立于失败任务状态 |
| 本机删除归属 | `aspera_removals` / `1` | 删除身份、可恢复本机清理、已删除服务器及未确认的远端任务 |
| 独立远端任务身份 | `aspera_remote_tasks` / `1` | 原提交摘要、固定节点和连接引用、保留的终态释放证据 |
| 本机准备 | `aspera_preparation` / `1` | 固定限制、原归档及摘要、每节点恢复预算、尝试和实测来源变更 |
| 远端安装进程 | `.aspera-installations` / `1` | 启动／进程时间身份、实际进展、退出回执及完整 stdout/stderr |
| 调度主机的实验运行目录 | `execution-progress.v1.json` / `1` | 精确绑定计划的 Agent 步骤上报、执行 Session、记录版本和程序时间 |
| 管理 Host 副本 | `aspera-run-records` / `1` | 完整脱敏事件、命令输出、训练日志、步骤记录、已有指标及持久读取位置 |
| Host 及原运行目录 | `interruption.v1.json` / `1` | 操作身份、原提交摘要、节点退出证据、释放结果及核验恢复 |

本地 fleet 存储兼容读取第 `1`～`5` 代；远端存储保持第 `4` 代并兼容读取第 `1`～`3` 代。协议 `1` 保留扩展版本 `0.1.0` 及原限制，协议 `2` 保留 `0.2.0`，协议 `3` 保留 `0.1.1`。在途任务使用原运行时；任务完成且清理确认后才替换不兼容控制服务。环境诊断、准备工具、存储选择和回执使用现有 Session 消息、工具事件及 Goal 操作，不修改 Session 格式。

节点命令记录使用 `${experimentId}_${commandId}` 作为单个安全文件名键。UUID 前缀区分不同实验中相同的 run ID；两个原始 ID 仍分别保存在记录字段中。命令启动、输出读取、服务健康／停止及清理共用同一键解析函数。`aspera_node` 记录字段及第 `4` 代保持不变，run ID 仍拒绝路径分隔符。本机更新不能修复已提交实验固定的远端发布；处理实验要求和保留的节点归属后，复制实验并使用已修复发布。

服务器偏好与已解析部署分开保存。创建固定名称、目标、所选调度主机、服务器、阶段模型、凭据引用、模式及策略；准备保存输入摘要、挂载、目录、程序路径、选盘理由和网络地址。协议 `4` 不设任务总预算。重试先核对远端接管状态，本机升级后仍保留 UUID、Session 和原发布。Session 缺失时需复制实验。原材料必须匹配保留的归档摘要或重新计算的发布摘要；归档缺失／无法核验时阻止恢复，不替换为当前发布。挂载或输入变化明确失败。未决命令取得退出证据后才能继续修改。第 1～3 代未完成准备需复制实验。

安装持久化变更确认：[安装定义](../packages/dispatch/src/installation-model.ts)新增独立的本机和远端第 1 代记录，不修改 fleet 第 `6` 代、远端任务／控制第 `4` 代或 Session 事件代次。恢复保留所有用户发起的预算及尝试。下载字节、包状态变化、实测编译 CPU／I/O 算进展，心跳和重试提示不算；总时限包含 Agent 诊断和修复。安装进程独立于 SSH 落实剩余限制，只在固定版本／文件检查通过后封存原材料的安装目录，环境验收仍是必要条件。停止需匹配启动身份、PID 和进程启动时间，并确认子进程组退出。退出未确认时，取消和离线删除仍保留节点归属；完成本机删除后清理未引用的归档，未确认删除保留私有记录。

Agent 换源前从所选节点实测 HTTPS 候选。仅作用于子进程的来源设置保留锁文件、TLS、包完整性及官方 Node 头文件校验值，排除用户源凭据。换源消耗重试次数并保留实测证据。管理端重启后，进行中的准备恢复原记录；失败实验需显式“重试准备”，保留历史并建立新预算。修改 profile 配置不会改变创建时固定的限制。

阶段快照记录提供商、模型、推理选项、固定的适配器版本，以及私有 API 配置的摘要和引用。支持移交 DeepSeek 官方及 pi-ai 密钥 API，包括 OpenAI 兼容的 Qwen；不支持的认证方式在提交前拒绝。每个 Agent 使用独立提供商作用域，全局配置修改及重试不能替换它。密钥和原始请求头不进入公开记录。

DeepSeek 快照保存带显式解析默认值的插件输入：重试延迟放在 `retryPolicy.backoff` 中，思考与文件设置使用提供商的配置字段。读取器先校验原回执哈希，再在内存中转换早期版本 1 的已解析快照，不改写私有内容、引用或哈希。格式损坏或混用两种布局时校验失败。[快照升级说明](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-model-snapshots/guide.zh.md) 定义重启与固定发布恢复方式。

调度服务先写入归属，再调度。队列记录丢失但留有执行证据时，需要操作人员核对，不能重新提交启动。重启后已确认清理的命令可以释放节点，任何未确认的受管进程范围继续占用节点。修复资源记录前，在相关节点检查并停止不明进程；页面不提供强制释放按钮。

第 6 代持久化变更确认：冻结的[第 5 代读取定义](../packages/dispatch/src/fleet-schema-v5.ts)保留旧请求及远端提交。新本机请求要求所选节点中的 `coordinatorId`；`registry.checks`、`deletions` 和 `deleted` 保存检查及删除状态。远端请求摘要与已发布记录不改写。Fleet 行为及存储测试覆盖历史读取、检查中断、清理重试、归属拒绝和删除标记去重。

观测持久化变更确认：[观测定义](../packages/experiments/src/observations.ts)新增独立的第 1 代文件；[错误提醒](../packages/dispatch/src/error-notices.ts)新增独立的第 1 代存储域。本机第 `6` 代、远端第 `4` 代、已发布 Session 事件定义及提交摘要均不变。目录缺失表示历史不可用。观测、事件、附件和错误提醒测试覆盖来源及游标归属、有界历史、不完整输出、轮转、精确附件引用及持久去重。

本机记录在任何状态均可删除，不等待 SSH 或远端取消；未结束任务需显式 `allowUnconfirmed`。服务器删除使用 `allowLinked` 时保留关联实验及固定连接。先保存的删除标记立即隐藏记录，阻止延迟控制回复、输入提交及 Goal 完成。本机上传副本和观测清理可在重启后继续。删除不表示远端进程已停止或资源已释放。

删除持久化变更确认：[删除定义](../packages/dispatch/src/removals.ts)新增独立 `aspera_removals` 第 `1` 代，本机第 `6` 代、远端第 `4` 代及冻结读取定义均不变。未确认记录保留连接引用、部署身份、提交摘要和未决命令位置；凭据仍保持私有。重新添加同一 SSH 地址，即使更换用户名也不能绕过未确认占用。[任务收尾](#remote-task-settlement)核验匹配的终态、进程和服务释放证据；连接检查保持只读。已删除服务器 ID 不可复用。

远端清理要求终态及已确认的进程清理、资源释放。持久操作标识固定清理选项，保存的节点进度支持重试。清理核对挂载和归属，拒绝嵌套挂载，将准确的实验目录隔离后删除，符号链接只删除链接本身。目录外仅删除已登记的私有移交文件，保留共享发布、控制状态、用户原始文件及普通 DSH 会话。部分失败保留实验；新的记录删除操作可立即完成，包括 SSH 清理仍在等待时。

-----

<a id="receipts-and-goals"></a>
准备命令持久类型确认：[命令监督](../packages/dispatch/src/preparation-command.ts)及其 [Linux 提供方](../packages/dispatch/scripts/preparation-command.py)在原准备目录内新增独立版本 1 的请求、进程身份、状态及日志游标。导入日志前核对实验、节点、命令、Session 和工具调用身份。继续读取已有数字退出回执；身份缺失不能授权重跑或停止。已验证的 uv 材料及未完成下载保存在带版本 1 索引的服务器缓存中。Fleet 第 `6` 代、协议 `4`、固定发布和 Session 格式保持不变。[准备命令恢复](../packages/dispatch/README.zh.md#preparation-command-recovery) 说明工具与限制。

## 回执与 Goal

`receipt` 保留首次接收的完整回执，`latest` 保存当前远端记录。两者均包含固定 `handover` 值**本机派发完成，远端实验已接管**。接收表示源码、输入及必要凭据已移交，调度主机已承担任务，不表示训练已经开始。资源分配和 Agent 启动后，补充执行 Session/Goal ID。

Host 先持久保存完整回执，再追加接管消息并完成派发 Goal。完成时比较原 ID 和版本号，旧回执不能完成已编辑或已替换的 Goal。浏览器实验使用独立 Session，普通对话中的 `/goal` 保持原有语义。

规划和执行 worker 在完成前以 `max-tokens` 结束回合时，持久保存 `blocked`，Goal 原因为 `aspera-model-token-limit`。调度端读取终态结果并核对受管进程，避免将已空闲的 Agent 保持为运行中。已完成命令不重复执行。[阶段上下文服务](../packages/runtime/README.zh.md#use-this-package)保留压缩事件、私有模型选择和既有 Session 归属。

半自动确认绑定显示的计划版本。同一版本重复确认是幂等操作，不同版本会失败。提交的要求不能原地修改；新的要求通过新实验重新确认。全自动策略确认与用户确认分别记录。

半自动问题绑定实验、Session、工具调用和固定的问题版本。调度服务先持久保存问题，再暂停 Goal；已有受管进程继续受到监控。回复先校验并保存，再交付原调用并恢复同一 Goal。相同回复重试是幂等操作；冲突、过期问题以及已取消或中断的任务不能恢复执行。重启将待回复问题报告为中断并使其过期，不重放工具。

-----

<a id="controller-readiness"></a>
## 控制进程就绪与恢复

准备 Agent 在原 Session 中调用环境探测、`repair_preparation_controller` 和复验。程序要求控制进程的固定发布与所选实验一致，再比较实际 GPU UUID、可访问字符设备和启动授权；集合排序避免顺序不同产生误报。功能一致不能授权复用其他发布。交接重新核对全部验收过的控制进程身份和配置摘要，新节点分配时独立再次探测硬件。已提交的 GPU 要求变化时，复制实验而不改写记录。

经过认证的健康接口声明 `controller-readiness-v1` 和 `controller-maintenance-v1`。维护操作检查调度端等待及活动任务、节点分配、命令和推理服务，再原子阻止新任务接入。修复工具自行解析 PID、Linux 启动身份、宿主启动身份、路径和固定发布，等待身份匹配的进程退出及端口释放后启动该发布。占用、未知及旧维护接口情形保留具体阻塞。限定进程字段仅允许在启动 GPU 证据和原发布匹配时只读复用；缺少证据不视为兼容。

控制端口离线时，程序通过 SSH 获取证据，不向已退出角色请求在线维护。程序读取两个角色的原运行目录、profile 绑定、进程身份及持久任务、命令、分配和服务记录。活动进程、无法读取的身份、待确认启动、排队任务或未确认退出都会阻止恢复。已结束的本地任务及已释放命令可收敛旧资源标记，同时保留原结果；多节点释放证据不完整时仍然阻塞。修改状态前，程序通过认证维护暂停仍在线的对应控制角色，并保留接入保护，直到恢复验收完成。

控制进程在原角色运行目录中使用按发布命名的 `aspera-worker-<deploymentId>` profile。固定发布的 setup 初始化私有暂存 profile，由程序核验后原子发布到派生名称。旧 profile、`node_modules` 绑定、任务存储和 Session 保持原位置。确认恢复后，仅按已验收 GPU 配置启动所选固定发布；普通准备 Shell 命令不能执行此操作。交接前，Agent 必须请求完整复验。

控制进程修复持久化类型确认：`$DSH_HOME/aspera-controller-repairs/<experiment>/<server>-<role>.v2.json` 中的版本 2 回执保存在线进程或离线归属证据、原两次上限、阶段及验收。版本 1 回执保持不变，其次数和上限初始化后继记录。远端恢复接入保护和退出证据是控制目录及实验专属目录中的独立版本 1 文件。再次修改前先核对同一操作；身份匹配的已启动进程被复用而不重复启动，结果未决时仍然阻塞。删除在确认释放前保留未决归属回执。fleet 第 6 代、远端协议 4、调度与节点记录代数及 Session 格式保持不变。`FleetDriver.ensureClusterRole` 接受可选的程序归属恢复 id。

-----

<a id="api-consumers"></a>
## 接口使用方

独立版本 1 的 `input-sharing-v1` 回执将已释放输入快照合并绑定当前实验及节点、认证内容、原文件身份和已完成替换。清理增加 `input-duplicate`，由 `inputSharingVersion: 1` 和 `managed-input-sharing-v1` 启用。独立 `release-asset-sharing-v1` 记录及 `release-asset-duplicate` 覆盖已知、不可变且空闲的发布资源，要求 `releaseAssetSharingVersion: 1`/`managed-release-asset-sharing-v1`。路径与字节保留；原文件时间存于回执。Session 和协议代次不变。

wheel 与缓存持久类型确认：独立版本 1 的 `input-verifications-v1`、`wheel-derivations-v1` 和 `cache-maintenance-v1` 将输入摘要、派生构建、未变载荷和包管理器退出结果绑定所属节点及操作。操作专属证明和管理器回执纳入归档。可选 `PrepareExperimentEnvironment.repairWheelMetadata` 要求显式修复计划；清理新增 `manager-cache`。旧记录继续可读。清单 `wheelMetadataRepairVersion: 2` 与 `managerCacheVersion: 1` 要求复用和交接前具备 `managed-wheel-metadata-v1`/`managed-wheel-metadata-v2` 与 `managed-manager-cache-v1`。协议 4、fleet 6 和 Session 格式不变。

工具快照持久类型确认：`storage-tool-observations-v1/<serverId>/<snapshotId>.json` 除原节点检查外，支持完整 `EnvironmentOperationStatus` 和 `EnvironmentOperation`。读取方区分操作身份，继续读取旧检查，核对实验归属，并对已保存原文分页，不改写回执。版本 1 外层和旧文件保留，协议 4、fleet 6 及 Session 格式不变。

持久类型确认：可选 `EnvironmentOperation.cleanup`/`recovery` 和 `EnvironmentStorageNode.cleanups`/`recoveries` 引用独立版本 1 清理与恢复文件。缺少字段的旧记录继续可读，原失败回执及时间保持原样，当前挂载 ID 只进入诊断。清单 `asperaEnvironmentTools.cleanupVersion: 1` 要求复用控制进程前确认 `managed-environment-cleanup-v1`。类型及生成的 Remote 使用方同步更新，协议 4、本机存储域 6 和 Session 格式不变。

安装持久类型确认：可选 `EnvironmentOperation.failure` 引用与原回执并列保存的独立版本 1 `EnvironmentFailure` 证据。请求、环境及节点身份必须一致，被拒绝的重试还需注明原操作。可选 `EnvironmentReusePlan.installerTemporaryBytes` 记录专属工具的临时占用。缺少这两个字段的旧记录继续可读。清单安装版本 3 要求固定 pip 和对应控制进程能力，协议 4、本机存储域 6 和 Session 格式保持不变。

`experimentStorageUsage`、`previewExperimentCacheCleanup` 与 `cleanupExperimentCache` 提供[受管环境观察和候选绑定清理](managed-environments.zh.md)。持久类型确认：[环境类型](../packages/experiments/src/managed-environment.ts) 定义独立版本 1 清单、引用、回执和本机观察；可选 `reusePlans` 和 `materials` 增加计划及带时间的材料描述，材料/锁定索引与启动记录独立保存，清理新增 `material` 候选。`ControllerStatus.features` 与 `PreparedEnvironment.requiredFeatures` 为可选能力字段；选定清单含 `asperaEnvironmentTools.reuseVersion: 1` 时，复用控制进程或交接前必须确认 `managed-environment-reuse-v1`。旧观察继续可读，本机存储域 6、协议 4、Session 事件和固定提交保持不变，生成的 Remote 消费者同步更新。

`experimentExecutionProgress` 读取固定调度主机的当前计划步骤记录，明确标注旧发布不支持的接口，核验实验、计划和执行 Session 归属，不更新远端发布。

`experimentSnapshot` 和重连快照增加 `installations`，包含每节点当前进度及此前恢复轮次。每次尝试保留已交付的来源告警类别、原始序号和采集时间，重放及应用重启不重复诊断。`retryPreparation` 返回 `{ record, installations }`。自定义 `ExperimentFleet.open` 调用者可在完整驱动之后传入已验证的安装限制，省略时解析为发布默认值。准备 Agent 使用限定范围的安装检查、候选探测及换源工具，随后必须通过程序验收。常规轮询读取已保存状态，不唤醒模型。

使用 [AsperaRemote](../packages/dispatch/src/index.ts) 及生成的 `@aspera/dispatch/remote` 描述。`previewExperimentDeletion` 区分 `recordDeletionAvailable` 与远端 `eligible`／`cleanupAvailable`；`previewServerRemoval` 列出保留任务。`deleteExperiments` 和 `removeServer` 接受未结束任务本机删除的显式确认。`experimentSnapshot`／`watch` 包含 `deletedIds`、`removedServerIds` 和 `unconfirmedWork`，重连保留这些身份及来源游标。`reconcileRemovedWork` 执行有界只读归属核验，`probeServer` 在共同连接截止时间内核验。检查保留带时间的状态、配置、结果及最近成功信息；SSH、GPU 和控制服务分别显示。其他方法覆盖模型、凭据、暂存、创建、重试、决定、取消、日志、文件及服务。Agent 工具共用 `ExperimentFleet` 准备服务。

`ClusterQueue` 使用验证持久数据的 `ExperimentTable` 和管理进程的 `ClusterExecutor`。`ExperimentFleet.open` 接受连接检查时限及完整的 `FleetDriver`，生产实现采用密码 SSH 和主机密钥校验。一个提供方同时负责移交、探测、凭据和认证操作。CPU 提供方仅存在于明确的测试夹具中，不进入发布文件。

控制接口需要私有 bearer 凭据，只监听回环地址。Host 通过受管理的 SSH 连接访问远端控制服务。节点的固定身份等于调度主机身份时，调度主机直接访问带认证的本机回环节点接口；其他节点继续使用 SSH。密码查询只返回是否配置及可写，密码由 DSH 凭据服务保存，并复制到受限的调度主机文件，以便控制分配的节点。模型要求、回执和常规浏览器查询均不返回明文。仅 `revealServerPassword(id)` 显式读取密码供当前编辑表单使用，不记录到日志或浏览器持久存储。

-----

<a id="execution-step-progress"></a>
## 执行步骤进度

checkpoint 持久类型声明：[保留记录](../packages/runtime/src/checkpoint-protection.ts)在各节点运行目录新增私有版本 1 的 `checkpoint-protection-v1/registrations` 和 `sealed` 文件，绑定原实验／节点、批准阶段、尝试、命令、必需恢复目录及实测文件身份。只读归档发现包含这两类记录，实验专属删除随运行目录清理。挂载 ID 仅实时核对，不保存为重启后的授权。协议 4、fleet 6、Session 格式及原阶段记录不变；旧固定发布不隐含这项 checkpoint 保护。

持久化类型变更确认：[执行进度定义](../packages/experiments/src/execution-progress.ts)在调度主机的实验专属运行目录新增独立的第 1 代文件。记录绑定实验 ID、批准的计划版本、从 1 开始的步骤序号和执行 Session，保存自身记录版本、各步骤状态、简短说明、调用 ID 和程序时间。现有计划、`progress.json`、fleet 第 `6` 代、远端协议／存储第 `4` 代和 Session 事件不变。实验专属清理随运行目录删除此文件。

文件不存在时，只读返回记录版本为零的待开始步骤，不写文件。认证的执行 worker 通过调度主机上报进行中、已完成或受阻；模型不能指定实验、Session、调用身份或调度主机代次。同步校验及原子替换拒绝并发覆盖、旧计划、错误 Session 和暂停或结束后的上报。相同重试不增加版本；受阻步骤可继续，已完成步骤不可重新开始。冲突返回可读取的当前版本以便修正；损坏或归属不符的文件明确报错并保留。

工具及诊断使用现有 Session 消息和工具事件。完成要求全部批准步骤上报为已完成，同时通过已有独立命令、节点及结果检查。旧实验保留固定发布；接口缺失时展示未记录步骤进度，不替换发布或推测完成。远端实验不存在属于读取错误，不视作接口不支持。页面在读取失败后保留最后成功记录及时间，区分首次读取失败，切换或删除实验后忽略迟到回复，实验停止后结束活动动画。

-----

<a id="experiment-interruption"></a>
## 受控中断

中断持久类型声明：[中断 schema](../packages/experiments/src/interruption.ts) 定义独立版本 1 回执，保存于 `$DSH_HOME/aspera-interruptions/<experimentId>.v1.json` 及各原运行目录的 `interruption.v1.json`。回执绑定操作、原提交摘要、触发原因、阶段、各节点退出证据、失败与确认结果。fleet 第 6 代、提交协议 4、Session 事件、发布、计划和硬件要求保持不变。Linux 命令在执行原沙箱参数前写入私有 `process-identities/<commandId>.v1.json`；PID、进程组、启动时刻与主机启动身份支持账号内受控停止，不补造退出码。

`interruptExperiment(id)` 在 Host 开始工作前持久化请求。`experimentInterruptionStatus(id)` 只读查询；快照包含 `interruptions`。重复请求复用操作。受阻重试重新核对实际证据。传输中断、超时与 Host 退出保留 `resumeVerification`；重启先读取远端回执和实际退出状态，再决定后续停止操作。远端已确认释放时复用结果，不再次停止。退出等待读取和写入结束；删除等待操作结束，未决恢复回执继续保留。删除标记拒绝迟到回复。切换页面或隐藏窗口不停止操作。`cancelExperiment` 保持返回类型，等待同一释放核验完成。

在线中断先阻止该实验新增工作，再使用原认证取消与节点释放接口。离线 SSH 核对固定提交、目录归属、具体进程身份、全部原命令和服务监听。只有确认属于实验的进程才能接收 TERM 和按配置升级的停止信号。旧版本身份缺失、节点不可达、PID 复用或证据无法读取时保留占用。全部节点释放后才能确认整体释放。用户停止使用 `cancelled`；自动恢复已退出控制进程的已启动任务使用 `interrupted`。可信原始终态保持不变。排队和等待计划确认任务要求手动中断；准备自动恢复不能停止活动任务或操作未选中的服务器。

准备继续使用 `repair_preparation_controller`：程序选择可收尾的旧任务、返回回执，并要求交接前完整复验。工具不接受模型指定 PID 或修改台账。界面展示中断进度、退出待核验及重试，同时保留日志、轨迹、文件和复制入口。连接检查仍保持只读、不调用模型并限时 20 秒。

-----

<a id="remote-task-settlement"></a>
## 远端任务收尾

持久类型声明：[远端任务定义](../packages/dispatch/src/remote-task.ts)新增独立 `aspera_remote_tasks` 第 1 代，不改写 fleet 第 6 代、删除日志、提交协议 4 或 Session 事件。最小身份保留提交摘要、节点连接及已确认的终态释放元数据，不复制完整 Goal 或模型凭据内容。删除本机实验后，既有中断日志继续提供操作和退出证据。

`remoteTaskStatus(id)` 返回不含凭据的进度，不进行传输。`settleRemoteTask({taskId, mode})` 在后台工作前持久化 `reconcile` 或明确的 `interrupt` 意图。准备阶段的既有控制进程修复通过同一中断模块处理可见及已删除任务。历史删除标记只有在核对调度归属、分配、摘要、发布和已登记节点账号后，才能恢复账号拥有的原提交。证据缺失时保留占用。必须核验全部原节点；准备不能扩大所选服务器范围。

核验收尾不停止活动任务。已启动任务只有在原调度控制进程退出且全部原工作确认停止后才能记为 `interrupted`；可信终态保持不变。明确中断只停止身份已核验的所属进程，沿用 `cancelled`。全部节点证据和可靠回执先于整体释放。共享环境、模型、数据、日志和固定发布继续保留。程序不自动重新训练。已删除行继续保持删除状态，服务器卡片提供待释放、核验、中断和重试入口。

<a id="local-running-records"></a>
## 本机运行记录

管理 profile 独立于页面可见性同步已接管的协议 4 实验。隐藏窗口或切换页面不停止同步。退出 Aspera 时停止本机读取并等待已提交写入，重新打开后从持久游标继续。不安装独立操作系统服务。准备阶段保留已有本机 Session 和安装记录。

归档持久化类型确认：[公开状态定义](../packages/experiments/src/archive.ts)及[私有版本 1 索引](../packages/dispatch/src/run-archive-store.ts)新增 `$DSH_HOME/aspera-run-records/<experimentId>/manifest.v1.json` 和不可变 SHA-256 JSON 块。索引绑定固定提交、节点、阶段、Session、来源代次、原序号、远端字节位置和独立本机分页位置。数据块校验且可靠落盘后才原子发布索引。半条 JSON 等待补齐；重复记录保留原身份。替换及截断保留旧副本并记录缺口。fleet 第 6 代、协议 4、现有步骤文件及已发布 Session 格式保持不变。

优先使用固定发布的认证读取。控制接口不可用时，[只读 SSH 工具](../packages/dispatch/scripts/read-archive.mjs)核对运行目录归属及保存的提交，只读取对应普通文件，拒绝符号链接。工具不启动控制进程、修复或训练。同一所选服务器的登记登录方式可更新；原发布、目录、硬件要求和提交不改变。凭据及带标签密钥在副本写入前脱敏。远端历史缺失和指标窗口过期保留为缺口，不补造缺失值。

`experimentArchiveStatus(id)` 返回整体及来源状态、最近尝试与成功轮次时间、已保存／积压字节、缺口和脱敏错误。即使没有新增字节，成功检查也更新 `lastSyncedAt`；检查进行时保留上次结果。`syncExperimentArchive(id)` 请求立即只读补拉，合并正在执行的轮次，不恢复执行。轨迹、命令、日志、指标和步骤接口优先读取已提交副本；未复制内容仍可访问远端。离线附件读取需要重连。历史状态保留原时间。本机读取成功不能清除远端连接错误。

在管理 profile 的 `aspera-dispatch` 中配置。[解析后的策略](../packages/dispatch/src/run-archive-reader.ts)验证以下设置；自定义 `ExperimentFleet.open` 调用者可在 SSH 连接策略之后传入。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `archiveEnabled`、`archiveIntervalMs` | `true`、`15000` | 启用复制及普通成功轮次后的间隔 |
| `archiveBacklogIntervalMs`、`archiveWaitingIntervalMs` | `5000`、`30000` | 仍有未读尾部，或已追上且等待计划确认／回复时的间隔 |
| `archiveReadBytes`、`archiveBatchPages` | `65536`、`16` | 有界分页及连续补拉轮次 |
| `archiveRetryMinMs`、`archiveRetryMaxMs` | `10000`、`60000` | 读取失败指数退避 |
| `archiveRequestTimeoutMs`、`archiveMetricGapMs` | `20000`、`900000` | 读取截止时间及指标缺失间隔阈值 |
| `archiveMinimumFreeBytes` | `1073741824` | 每次数据块／索引写入前的保留空间 |
| `archiveCatalogEntries`、`archiveCatalogBytes` | `10000`、`8388608` | 探测及响应上限 |
| `archiveLogPatterns` | `**/*.log`、`**/logs/**/*.txt`、`**/logs/**/*.jsonl` | 工作区训练文本匹配 |
| `archiveExcludeDirectories` | 依赖、环境、模型、数据集及缓存 | 扫描跳过的目录名 |

各间隔从上一轮结束后计算。未读尾部优先于等待人工处理的间隔。失败默认在 10、20、40 秒后重试，此后保持 60 秒；成功轮次重置退避。同一服务器串行读取。磁盘不足或写入失败只暂停同步，不修改结果或删除已有数据；恢复后从已提交索引继续。终态资源释放会立即请求最后一轮。所有节点均已读取、当前尾部已复制且所有已知命令确认释放后，才停止自动读取。缺失历史继续展示，不会为不可恢复的数据无限重试。重新打开 Host 会复查一次终态记录；仍可手动同步。EOF 仅表示已追上，不代表训练成功或证据完整。副本保留至删除实验。删除先保存标记，中止并等待全部所属读取，再清理副本；迟到回复不能发布数据。[归档回归](../packages/dispatch/tests/run-archive.spec.ts)覆盖这些时序与归属规则。

-----

<a id="logs-outputs-and-services"></a>
## 日志、产物和服务

`experimentTrace` 分页绑定实验、阶段、Session 及原始序号。准备读取本机派发 Session，计划和执行读取各自保存的远端 Session。大的远端事件经摘要校验的分块读取后才进入官方组装器。`experimentTraceEvent` 和 `experimentTraceAttachment` 校验精确事件归属；附件必须由该事件引用并通过已发布附件提供方的内容校验。缺失或截断的旧记录明确标注，不作为完整事件解析。只读工厂不会将远端实验注册为可编辑的普通 Session。

`experimentLogSources`、`experimentLog`、`downloadExperimentLog` 和 `experimentMetrics` 提供实际登记的来源和指标。新来源清单及 JSONL 记录保存实验／节点／来源身份、输出流、采集时间及序号，游标另外绑定文件代次。不完整尾行等待后续内容，文件替换或缺失明确提示。准备和 Agent 输出在工具结果截断前采集；受管命令分别采集 stdout/stderr；旧混合文件保留未知时间和流别。已知凭据及带标签的密钥在公开前脱敏。下载票据一次性使用、到期失效并拒绝文件代次变化；正在阅读的历史与新接收的尾部各自保持有界缓存。

节点 `observations` 默认设置为 `intervalMs: 2000`、`historyMs: 900000`、`readBytes: 65536` 和 `metricSamples: 1000`。客户端轮询、曲线保留和读取／缓存上限可在 [Config](../packages/console/src/config.ts) 独立配置。资源指标来自操作系统计数及 `nvidia-smi`，训练指标只来自 `report_experiment_progress`，缺失数据保持缺失。断线保留最后有效值及采样时间，并在曲线上留下空隙。旧固定运行时展示已有日志，不生成新观测。错误指纹独立于任务与来源状态保存；本机快照读取成功不能清除远端失败。

输出接口列出相对路径、来源节点、大小和更新时间。下载使用一次性过期票据和有界读取，拒绝路径越界、符号链接逃逸及文件代次变化。下载断线会中止上游读取，普通产物和二进制附件仍按需下载。

服务具有独立 UUID、所属实验及节点、模型路径、命令身份、回环端口、健康接口和清理状态。仅旧记录带有服务截止时间。启动要求端口未占用，健康要求受管进程存活且实际 HTTP 检查成功。私有访问支持有界的 GET/POST 请求。可选 `inferenceMapping` 将平台 HTTPS 基础地址及映射端口固定在服务器快照中。`start_inference_service(publish=true)` 在映射端口提供 Bearer 认证入口，将 GET/HEAD/POST 流转发到回环地址上的模型；模型端口必须与映射及控制端口不同。节点通过外部地址检查服务／实验身份及随机校验值，独立于本地健康状态保存 `external.state`，拒绝重定向。节点发起的检查不保证所有调用者网络都可访问。服务密钥位于 Agent 工作目录之外的节点私有文件中，不进入回执、日志或 Agent 工具结果，仅操作人员主动调用 Remote `serviceAccessInfo` 时返回。停止、取消及进程退出会关闭对外监听；节点重启不重建身份未经核实的监听器。停止或取消后，确认受管进程清理才释放资源；异常退出为终止状态，不自动重启。
