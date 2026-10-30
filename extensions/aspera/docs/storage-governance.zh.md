# 服务器存储与固定材料

[English](storage-governance.md) | 中文

## 摘要

Aspera 的准备与执行 Agent 通过限定范围的工具请求存储观察、环境复用及固定模型／数据材料。Host 解析所选服务器与原提交；节点负责测量、核验、预留、安装和下载。整个流程不增加编排 Agent，也不修改 Agent 主循环。已有环境、模型、数据、结果、日志和封闭发布继续保留。

## 目录

- [账号视角盘点](#account-inventory)
- [存储登记](#storage-registration)
- [历史环境](#historical-environments)
- [容量与清理](#capacity-and-cleanup)
- [固定模型与数据材料](#fixed-materials)
- [定向材料核验](#targeted-material-verification)
- [历史来源自动复用](#automatic-history-reuse)
- [环境预核验与保留策略](#storage-preflight)
- [Agent 选择环境修复](#agent-selected-environment-repair)
- [记录与兼容](#records-and-compatibility)

-----

<a id="account-inventory"></a>
## 账号视角盘点

准备工具 `inspect_server_storage` 使用 SSH 登录账号。执行工具 `inspect_experiment_storage` 使用同一节点服务。归属根来自保存的存储选择、控制目录的存储根登记及归属标记。容量观察还包含所配置的本机挂载前缀，但不接管或递归扫描归属不明的目录。账号可写、沙箱可写及历史目录被隐藏分别记录；未知值保持未知。

选择存储时，程序在一次本机记录更新中保存目录安排及其对应的磁盘观察。尚未提交的准备任务原地重试时，重新探测所选目录，核对原服务器、实验、发布和挂载身份后，再一起提交两份记录。空闲空间变化可以更新观察；归属或挂载改变、存储不可写或容量不足时拒绝重试。既有路径、发布、环境、模型和日志保持固定，已提交实验保留原提交。

目录索引区分发布、环境、安装包、模型、数据、临时文件、断点、结果、日志和其他归属文件。逻辑大小统计目录项；实际分配空间按设备号及 inode 去重。文件系统空闲空间独立测量。未归类占用包含尚未扫描及归属不明的内容，不代表清理授权。有限扫描保存游标与原测量时间。概览读取保存的索引；刷新或继续扫描才会明确请求更多检查。根目录归属或存储卷身份变化时不接管内容。

`managedEnvironments.governance` 配置默认 `scanEntryLimit: 100000`、`scanTimeoutMs: 10000`、`snapshotFileLimit: 200000` 和 `verificationTimeoutMs: 300000`。超限或无法读取的扫描保持不完整。`inventoryMountPrefixes` 控制只测容量的发现范围。挂载 ID 仅描述当前观察，不提供跨重启授权。

<a id="storage-registration"></a>
## 存储登记

复制的容器会保留历史磁盘观察。准备阶段的 `verify_server_storage` 与执行阶段的 `verify_experiment_storage` 将 `operationId` 绑定到盘点返回的 `rootId`、`observationId`。程序在共用准入锁内核验归属、实际挂载、目录身份和可写性。存在活动写入或旧进程退出未确认时拒绝登记；发起请求的 Agent 可以继续在其未改变的固定位置运行。登记不会杀进程、释放分配或移动实验目录。当前实验的固定位置发生变化时仍保持受阻。

登记前先保存请求。相同请求恢复同一操作，观察变化后必须重新盘点。当前指针选择不可变的历史登记，原始根目录观察继续保留。新登记使旧候选 ID、扫描游标、历史环境证明及材料文件证明失效。规范清单仍保留材料身份，当前内容必须重新核验。Agent 的调查顺序和候选选择独立于登记操作。

持久化类型确认：登记观察、请求、历史与指针采用独立的 `version: 1`、`formatVersion: "0.1.3"` 记录，位于 `state/storage-governance-v1/registrations-0.1.3`。借用与材料证据增加可选 `registrationId`；旧记录保持可读，新登记要求重新取得证明。新固定发布声明 `registrationFormat: "0.1.3"`，要求 `storage-registration-0.1.3`、`bounded-diagnostics-0.1.3` 和 `command-admission-0.1.3`。其准备流程通过同一核验器登记所选根目录，旧固定发布不执行这项准备操作。本机第 6 代、远端协议 4、原提交与材料格式 0.1.2 保持不变。

<a id="historical-environments"></a>
## 历史环境

`prepare_experiment_environment` 先检查已有受管 `training` 环境，再在创建另一套环境前核验已释放的历史候选。可选 `reuseCandidateId` 选择程序生成的候选。源分配、终态资源释放、命令／服务释放、进程状态、解释器、ABI、RECORD 内容、链接、`.pth` 路径、依赖、指定导入及所需 CUDA 均需核验。固定版本 uv 通过临时只读元数据挂载检查依赖约束，训练环境无需为此安装 pip 或 packaging，源文件保持不变。仅有元数据目录不能说明环境可用。历史发现不完整时禁止自动安装第二套环境。

`historical-environment-precheck-v1` 在核验来源前拒绝不支持的直接来源约束。确认源任务已释放后，程序只读元数据，在计算包内容摘要或执行历史解释器前拒绝缺少无条件固定版本依赖的候选。元数据不完整、旧式安装布局及额外 `.pth` 路径继续交给完整核验，条件要求仍由 uv 判断。通过这项初步检查不会发布绑定，也不能代替完整性、依赖、导入或 CUDA 核验。

匹配来源登记为经过核验的历史安装环境，不伪装成已验证 wheel 来源。程序先原子保存来源租约，再发布当前实验绑定。命令和推理服务仅只读挂载环境及必要解释器路径，继续隐藏源实验的其他文件，并使用返回的绝对解释器。用户级包和字节码写入被禁用。来源文件、解释器链接或存储卷变化需要复验。绑定保留期间，源实验的命令、修改与远端删除被拒绝。发布和来源删除共用控制进程准入锁。`make-writable` 不能修改借用源。

借用不执行依赖安装，也不创建第二套 venv。不满足要求的候选保留具体差异。明确请求的独立安装使用自己的预算和已有受管代次机制，不修补来源。同盘经过核验的共享包库可贡献链接后的 wheel 与包内容，无需展开。跨盘缓存导入单独报告，不静默复制全部历史包。实验结束及仅删除本机记录后，环境与来源引用继续保留；确认远端绑定删除后才释放当前实验引用。

<a id="capacity-and-cleanup"></a>
## 容量与清理

按用途安排时，容量按实际文件系统设备合并，不同目录和绑定挂载共用一份保留空间。`managedEnvironments.governance` 增加 `systemReserveBytes: 5368709120`、`systemReserveRatio: 0.10`、`dataReserveBytes: 2147483648` 和 `dataReserveRatio: 0.05`；各盘取绝对余量、比例余量及原最低空闲要求中的最大值。`peakSafetyFactor: 1.20` 覆盖新增下载、解压／编译、复制及共存估算。`capacityRecheckMs: 5000` 限定受管安装期间的轻量容量复查间隔，不重复扫描索引。

可选 `environmentEstimate: { peakBytes, basis }` 声明有依据的新增峰值，不代表已核验安装体积。`allowEnvironmentFallback: true` 先检查历史复用。数据盘仍不足时，程序可以在控制目录所在的系统文件系统登记尚未使用的训练环境。模型／数据／输出所在各盘仍需容纳剩余内容，系统盘需容纳峰值、其他任务预留及保留空间。已有环境请求、安装回执或已发布环境禁止迁移。估算未知保持待核验；空间不足保留逐盘缺口及未生效的回退评估。

独立环境工作区和包仓库不改变已提交的数据工作区及材料身份。发布、命令只读挂载、历史复用和已确认的远端删除核验其归属和文件系统。回退生效后显示一次官方悬浮 Toast，提供存储详情入口；管理 profile 的通知认领跨切页、刷新和重启保留。关闭提示保留位置安排历史。

`assess_experiment_storage` 绑定 UUID 操作、环境要求、正式材料 ID、输出字节及断点字节，逐挂载卷计算容量。缺失材料、环境剩余峰值、必要独立副本、输出／断点增长及已有最小空闲预留共同检查。经过核验的复用不重复计算整套安装。未知依赖估计保持待确认。已测量的结果／断点增长减少后续声明输出预留。仅通过部署安全余量，不代表训练容量通过。

安装、材料获取及已有声明容量计划的普通命令会重复执行程序检查。服务器持久预留协调其他实验；相同物理材料不重复预留。连接丢失或进程退出未决后，预留继续保留。节点确认释放后移除容量预留；环境和材料引用具有独立生命周期。普通 Shell 接口不是文件系统配额，程序也不使用 Shell 关键词匹配推断资源需求。

清理预览包含已确认退出的安装私有残留、无引用的受管共享包对象，以及有有效保留副本的重复 wheel。唯一已验证 wheel、环境、模型／数据、断点、脚本、结果、日志和发布默认排除。历史候选需要明确选择候选 ID 及原预览摘要。清理重新核对引用、进程退出、来源身份和包库锁。目录描述符相对删除及真实挂载 ID 保留越界、符号链接、嵌套挂载与 bind mount 保护。部分清理保留回执与剩余证据；普通临时文件删除失败不使已验收环境失效。安全或退出结果不明仍然阻塞。

<a id="fixed-materials"></a>
## 固定模型与数据材料

`inspect_experiment_materials` 获取 Hugging Face 正式仓库及不可变的 40 位 revision 清单，包含每个所选文件的大小及 SHA-256 或 Git blob 身份。`files` 选择必要内容。节点无法访问时，Host 可获取同一份有限大小的正式元数据，再通过认证程序接口提交。镜像传输结果必须符合正式文件内容。ModelScope 接受 revision 参数不能证明 Hugging Face commit；没有受支持不可变身份确认的直接来源请求继续阻塞。

`canonicalDatasetVersion: 1` 要求 `canonical-modelscope-dataset-v1`。对于 `provider: modelscope` 数据集，Host 使用 Git 核对官方精确提交、目录树以及普通 blob 或 LFS 身份，不检出仓库、不取得 LFS 文件。Host 必须具备 Git；元数据输出及临时仓库大小使用 `managedEnvironments.readBytes`，沿用现有读取期限、轮询和取消。正式清单保留 `source: {provider: "modelscope", method: "git-commit-tree-v1"}`。节点独立核对所请求的身份和文件内容。模型镜像继续要求 Hugging Face 正式清单。安装也会拒绝遗漏已登记材料 ID 的局部预算。

`prepare_experiment_materials` 接收检查后的材料 ID 和原操作 ID。只读 `verify` 不需要下载预算，也不发布材料。`acquire` 需要已通过的容量计划 ID；`recover` 保留原动作。历史文件通过来源释放核对后可以只读引用，不生成另一份权重副本。新下载写在数据卷最终位置旁，核验后发布。完整文件与经过核验的部分分片在失败后保留；断点传输核对偏移和完整内容。共享文件依次采用硬链接、实测写时复制，以及重新容量准入后的独立复制。

每个材料身份只有一个下载所有者。服务器传输槽默认一个；匹配请求复用持久状态。工具等待最终回执、真实退出及准入释放。`materialTimeoutMs` 默认 7200000，`metadataWaitTimeoutMs` 默认 120000，`networkReadTimeoutMs` 默认 30000；轮询和重连沿用环境操作配置。重连不重置原期限。取消和超时保留停止原因，恢复前必须确认退出。模型可见诊断与结果保存在原 Session。

`materialRecoveryVersion: 1` 要求 `managed-material-recovery-v1`。核验完成后，仍可能需要确认退出并提交收尾记录。收尾失败时，工具返回诊断和原操作身份，不再等到下载期限才返回。`recover` 重新核对原命令已确认退出及其他活动任务，再提交收尾，不重新启动核验或下载。活动进程或退出未确认时保留准入限制。辅助程序读取失败时同时保存 stdout 和 stderr。

持久类型变更确认：`material-operations-v1/<operationId>/settlement-failure.v1.json` 是绑定实验、节点与操作的独立版本 1 诊断。材料响应增加可选 `settlementError`，消费者将其与下载失败区分。恢复成功后，只有完成收尾及准入释放才移除已解决的诊断。已有回执、固定发布、协议 4、fleet 6 和 Session 格式保持不变。

命令与推理服务通过只读挂载使用返回的本地路径。登记材料后，Hugging Face、Transformers 和 Datasets 默认离线加载，避免框架再下载另一份。命令启动与完成时重新核对材料绑定和文件身份。程序记录的硬链接创建允许其预期 inode 元数据变化，未登记的文件变化仍无法通过检查。

<a id="targeted-material-verification"></a>
## 定向材料核验

Agent 自主选择调查顺序。两个存储检查工具均接受 `scope_json`：`{kind:"account"}`、`{kind:"experiment",experimentId}`，或已确认根目录下的 `{kind:"directory",rootId,relativePath}`。游标绑定节点、范围和实测挂载身份。`materialCandidates` 表示已归属目录，不代表内容已核验。将候选的 `reuseCandidateId` 传给材料检查与核验，无需完成无关的全账户扫描。隐藏或尚未扫描的内容不能证明整个账户不存在材料。

规范清单请求在联网前持久保存。`metadataSource` 可选 `auto`、`node`、`host` 或 `cache`；auto 依次使用可信缓存、节点探测和 Host 桥接。`metadataProbeTimeoutMs` 默认 10000，必须小于 `managedEnvironments.readTimeoutMs`；大文件下载配置不变。待处理请求在重连和重启后保留同一期限。元数据读取不执行大文件哈希。受管核验保存完整文件摘要及设备／inode、大小和时间身份；文件变化会使检查点失效。复用前仍须通过来源归属、规范摘要及释放核验。

容量 `coverage` 区分 `assessmentScope: "declared"` 与 `"experiment"`。局部就绪仅覆盖本次提供的需求。完整范围需要登记 `materialRequirements: {planRevision,complete,materials:[{kind,repository,revision,files?,materialId?}]}`。缺少绑定、规范清单未取得或历史候选未核验时保持待核验。需求由 Agent 明确声明，并与规范记录核对，不从计划文字推断。已核验的直接复用不重复计入权重分配；独立复制保留实际峰值和预留量。清理预览发现已登记的重复 wheel，不同步计算完整摘要；受管清理在删除前核验所选与保留的两个副本。

持久类型变更确认：定向候选、操作关联、材料需求声明和逐文件检查点使用独立的 `version: 1`、`formatVersion: "0.1.1"` 记录。目录与容量计划增加可选范围、候选和覆盖字段，保留原读取能力。发布清单 `asperaEnvironmentTools.materialFormat: "0.1.1"` 要求 `targeted-materials-0.1.1`。原远端发布只接收自身支持的配置，不能静默接受新操作。桌面资源更新不会恢复受阻实验或替换其固定发布。

材料身份与实际目录分别保存。检查读取规范内容与默认资产；可选候选只描述该来源，不为后续操作隐式选择来源。校验接受 `materialId` 和明确的 `reuseCandidateId`，不限制发现顺序，在启动前固定来源，逐文件保留通过、缺失、摘要不符、无法读取和尚未校验的结果。旧发布省略候选时只验证默认资产；具备自动复用能力的新发布按下述规则选择来源。相同请求会指出原操作；恢复保留原来源、检查点和截止时间。

容量通过 `materialSources: [{materialId,verificationOperationId,mode}]` 选择校验来源，`mode` 为 `readonly` 或 `copy`。回执必须属于本实验、节点和批准计划。只读复用要求全部规范文件通过；复制可在独立受管目标中复用已核验文件，仅取得缺失或损坏文件，未知文件使评估保持待核验。硬链接或克隆失败时，必须先确认独立复制所需空间再写入。源文件保持不变，发布前必须通过包括仓库元数据在内的全部必需规范文件校验。

来源快照、逐文件操作结果、容量估算和实验专属发布使用 `version: 1`、`formatVersion: "0.1.2"`。发布绑定与沙箱挂载读取本实验的发布记录，不读取可变化的全局来源。兼容保护索引让旧清理器继续保留源文件，直到消费实验确认删除。清单中的 `materialFormat: "0.1.2"` 要求 `material-source-bindings-0.1.2`；原操作和旧记录保留读取能力，不能隐式采用新来源。这些独立记录不改变本机第 6 代、协议第 4 代及提交摘要。

<a id="automatic-history-reuse"></a>
## 历史来源自动复用

程序先从归属已确认的就绪环境清单发现来源，再调查缓存中的旧目录。清单只是线索，来源释放、全部内容、依赖及所需 CUDA 仍须核验。同一次核验在文件间复用存储登记与挂载观测，并在发布前重新核对。清理检查仅复用文件身份未变的引用元数据；一次预览对同一未变物理发布资源只计算一次摘要，后续预览重新取得内容证明。

声明 `asperaEnvironmentTools.reuseVerificationVersion: 1` 的发布要求 `storage-reuse-verification-v1`。新核验未指定候选时，程序发现归属已确认的等价来源，选择新增空间最少的来源；显式候选保持原来源。当前绑定优先于受管和历史来源，同等候选稳定排序。零新增来源通过后无需等待无关全量盘点。缓存链接必须位于授权仓库缓存内，发布时使用受保护的受管视图。原操作的来源选择和期限保持固定。

发现保存有预算的目录游标，存储登记变化后重新发现并核验。扫描页默认 10000 毫秒，必须短于默认 30000 毫秒的读取上限。深度核验由节点操作执行，沿用 300000 毫秒预算、轻量状态轮询和逐文件证明。读取超时不会停止该操作。哈希前保护已释放的来源，发布时重新检查归属和文件身份。读取错误区分取消、超时、输出超限与进程失败，并保留私有诊断。

容量评估消费已退出的来源回执，不启动扫描或发布环境借用。遗漏已登记要求、复用未核验时继续待确认。已验证来源不重复计算内容占用，缺失文件、复制、输出和断点预留继续计费。新的匹配计划替代旧缺口证据，历史记录保留。`inspect_experiment_environment` 返回有界摘要，通过 `details_json` 读取保存的分页；`storageToolResultBytes` 默认 8192。对象分页在该预算内直接提供标量 `value`，并保留每个字段的 `page`；未直接提供值时再读取详情。完整观察保留原检查时间，并纳入运行归档。

持久类型变更确认：发现、选择、核验进度、已登记容量要求与工具观察使用独立版本 1 记录。发现游标帧增加可选 `registered` 和 `manifestOffset`，用于有界清单遍历，旧帧仍可读取。材料操作增加可选 `reuse`、`discovering` 和已核验缓存映射，环境计划增加 `checking-reuse`，容量计划增加可选复用状态。旧记录继续可读，已有操作保留原来源语义。原固定发布、协议 4、fleet 第 6 代及 Session 格式不变。

<a id="storage-preflight"></a>
## 环境预核验与保留策略

声明 `storagePreflightVersion: 2` 的发布要求 `storage-preflight-v2`。`prepare_experiment_environment` 的 `verify-reuse` 操作只核验已有来源，不安装或发布。`preflight` 区分可复用、需要修复、不兼容和未知；RECORD 文件大小差异先于完整快照摘要检查。Agent 选择借用、程序提供的修复计划或其他候选，旧文件保持不变。

具备能力的发布中，`assess_experiment_storage` 默认 `mode: preview`。试算保留估算，不发布当前准入预算或预留空间。`materialRequirements` 中提供的材料 ID 自动计入 `materialIds`；完整需求集合默认按实验范围检查，调用者仍可显式选择声明范围。`mode: commit` 选择已批准策略版本，要求环境调查已有确定结果。纠正字节估算保持相同保留策略，明确的空间下限仍有效。来源证明绑定原计划、Session、发布和当前文件身份，未知复用不能变成零字节估算。

声明 `requirementLedgerVersion: 1` 的发布要求 `storage-requirement-ledger-v1`。依赖试算和失败提交不能修改已发布环境的要求。重新评估以当前受管清单或已核验历史绑定为准，明确列出遗漏依赖。Agent 通过环境安装工具变更依赖集合后再评估，早期试算仍可读取。已登记固定材料、已批准保留下限和来源核验继续有效。

批准计划中的 `storagePolicy` 描述产物类型、断点数量、优化器／调度器状态、必需恢复点、明确空间下限与依据。`get_experiment_storage_policy` 读取当前决定；Agent 通过 `propose_experiment_storage_policy` 提出内容变化，由 Host 按预期版本批准或拒绝。自动模式仅接受保留原批准全部要求的提案；人工确认在工具内部等待，不触发模型轮询，也不向 Agent 提供批准权限。策略读取与目录盘点使用独立锁。概览展示待确认差异，原计划步骤保留。

材料核验分别记录 `verificationStatus: complete|partial|none|unknown` 和 `materialReady`。正常调查可以以部分内容结束，取得材料仍需有效预算及完整清单发布。匹配文件保留，只取得缺失内容；网络复用与跨盘复制分别计费。部分调查和试算缺口不能独立证明整个实验无法继续。

持久化声明：预核验、保留策略提案／决定和试算／准入关联使用独立版本 1 记录。旧操作保留原读取方式，协议 4、本机存储域 6、Session 和提交保持固定。新消费者还读取可选的预核验、预算模式／策略版本及材料核验字段。旧实验释放资源后再复制到支持新能力的发布。

`reconsiderExperimentStoragePolicy(id, proposalId, expectedRevision)` 允许操作者明确批准已拒绝 Agent 提案的后继记录。提议内容不变；原拒绝结果保留，后继记录关联原提案身份。版本及节点／计划检查继续生效。全自动模式中的提案若减少已批准保留内容，则等待 Host 确认，不能自行批准缩减。

<a id="agent-selected-environment-repair"></a>
## Agent 选择环境修复

Agent 可以选择其他历史候选、请求重新检查来源，或通过 `prepare_experiment_environment(action: "repair")` 选择程序发出的 `repairPlanId`。修复保留有效依赖要求及同一环境身份；调整依赖使用 `install`。方案绑定实验、节点、原操作、依赖及来源证明。程序核对这些身份和原进程退出后才安装。下载、复制及峰值估计在材料解析和空间检查完成前保持未知。

修复从可信材料组装私有新代次，通过解释器、依赖、导入及所需 CUDA 检查后发布。匹配的共享内容继续使用硬链接，只获取缺失材料。历史环境及 RECORD 文件保留原样。未变化的内容失败复用来源证明；`recheckSource: true` 明确请求重新检查。超时和不可读来源不缓存为损坏。空依赖只创建基础解释器，除非已有绑定或显式候选选择了历史借用。

`inspect_experiment_environment` 先解析节点响应，再分页返回存储观测、操作、启动记录、诊断和修复方案。扫描失败仍保留原错误和进程记录，缺失测量保持未知。已知旧包装格式继续可读，缺少独立退出证据时进程状态为未确认。

来源释放检查区分原任务与当前分配中仅只读访问保留文件的命令。豁免要求父子归属经过验证，进程、启动时间、主机启动身份和活动命令一致，且可写目录互不相交；子进程可以创建自己的会话。安装、清理、未知进程和归属冲突继续阻塞。`readonlyConsumerVersion: 2` 要求 `readonly-source-consumers-v1` 和 `readonly-source-consumers-v2`。验收失败保留稳定的错误说明，各次保存的诊断位置单独返回，因此新诊断编号不会阻止收尾。

清理预览将 `referenceRepairs` 与文件候选分别展示。Agent 通过 `reference_repair_ids` 选择合格 ID；Host 请求使用 `referenceRepairIds`。仅确认引用的请求不删除缓存文件。确认要求存储归属、原删除证据、任务终态及进程释放、没有保留借用，并且引用身份未变化。持久确认先于所选引用释放，原清单、结果和日志保留。证据缺失时引用继续保护相关内容，同时保留其他检查结果可见。

已记录覆盖范围时，训练命令要求完整容量覆盖。声明范围内的 ready 计划不能证明整个实验已经就绪。已登记模型与数据要求、环境分配、输出与断点预留和安全余量持续计入，直到核验过的复用证明替代对应分配。

持久类型变更声明：诊断和修复方案分别使用 `environment-diagnostics-v1`、`environment-repair-plans-v1` 下的独立版本 1 文件；引用确认使用 `environment-reference-releases-v1`。服务器拥有的 `environment-failures-v1` 保存内容失败缓存、来源身份和核验规则。`operation-contexts-0.1.1/environment-operation` 将完成证据绑定原计划及 Session。原回执保持不变。新读取器接受已有记录。修复动作、可选回执观测及引用选择要求同步更新消费者。新写入要求 `asperaEnvironmentTools.repairVersion: 1` 和 `managed-environment-repair-v1`；旧固定发布不接收修复或引用确认操作。协议 4、fleet 第 6 代及 Session 格式不变。

<a id="records-and-compatibility"></a>
## 记录与兼容

按用途安排的持久类型变更确认：`storage-arrangement.v1.json` 使用 `version: 1` 和业务 `formatVersion: "0.1.0"`，绑定节点／实验归属、原工作区与环境工作区、文件系统证据及稳定的回退事件。容量计划增加可选格式、估算依据、安全系数、实际容量／设备、新增峰值、缺口及回退评估；观察增加可选 `arrangement`。缺少这些字段的历史记录继续可读，后续业务格式使用 `0.1.x`。fleet 第 6 代、远端协议 4 和原请求摘要不变。

发布清单 `asperaEnvironmentTools.storageFormat: "0.1.0"` 要求 `purpose-storage-0.1.0`。旧固定发布只接收其支持的配置字段；存储能力变更遵守受控空闲修复流程，更新桌面资源不重启远端实验。Aspera 保持 0.1.1，DSH 保持 0.2.0-rc.2。

持久类型变更确认：[存储定义](../packages/experiments/src/storage-governance.ts) 增加独立版本 1 的目录索引、历史环境快照／绑定／租约、容量计划／预留、正式材料／索引／引用及操作记录。控制目录索引位于 `state/storage-governance-v1`；实验借用、计划、绑定及操作文件位于原运行目录旁。材料回执保留原请求身份及期限，运行记录保留实际停止与退出信息。新增操作记录纳入已有本机归档。原环境清单、失败回执和封闭发布不变。

存储观察通过可选字段暴露目录索引、借用摘要、计划、材料及操作。`experimentStoragePlan(id)` 读取保存的计划；`refreshExperimentStorage(id, serverId, cursor?)` 明确推进账号视角盘点。现有空间与清理接口保持参数兼容，选中候选 ID 为可选扩展；消费者同步更新。离线界面保留测量时间及连接诊断，不补造缺失数值。删除会等待 Host 读取结束，再移除本机观察，并拒绝迟到回复。

发布清单 `asperaEnvironmentTools.storageVersion: 1` 要求准备、控制进程复用及交接共同具备 `storage-governance-v1`、`historical-environment-borrow-v1` 和 `managed-materials-v1`。现有协议 4 实验保留原固定实现。确认资源释放后复制实验使用新工具；不改写原硬件要求、结果和目录。协议 4、fleet 第 6 代及 Session 格式不变。“检查连接”保持只读、不调用模型，限时 20 秒。

在已授权的 Linux 节点，用独立测试发布、已选模型快照及其凭据文件运行 `pnpm -C extensions/aspera run test:storage:qwen -- <isolated-config.json>`。测试器使用正式 profile 和限定范围的工具，保存实际模型回答，通过认证接口处理操作者的策略决定，并核验资源释放。真实模型结果与无密钥回放、CUDA 及正式训练分开记录；合成成功不能替代真实服务器观察。
