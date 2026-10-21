---
description: "面向运行时提供方的 Aspera 版本化实验请求、整组服务器调度及有界日志和文件访问。"
kind: "package-library"
---

# @aspera/experiments

[English](README.md) | 中文

## 概要

建立持久实验队列，整组分配所有请求的服务器，使不共享服务器的任务并行，并保留无法核实的占用。使用管理页面和节点共用的定义解析固定请求及完整回执。通过包含代次的游标和受限路径读取有界日志及输出清单。进程执行由独立的提供方实现。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

从包根导入 `ClusterQueue`、请求及记录 schema 和文件工具；浏览器程序从 `@aspera/experiments/types` 导入声明。提供验证持久读取的 `ExperimentTable` 和负责启动、取消及恢复的 `ClusterExecutor`。打开存储后调用 `recover`，释放存储前调用 `close`；接收方法在持久写入后返回，不等待执行完成。

共享服务器的先入队任务优先于后入队任务，等待确认的任务不预留服务器。整组分配在启动进程前写入单个实验记录，清理不完整时保留整组占用。相同提交 ID 及内容返回当前回执，修改内容则失败。[队列测试](tests/cluster-queue.spec.ts) 包含最小的完整存储及提供方组合。

问题和回复与队列修改串行处理。暂停前保存未回答问题，交付前保存一份经校验的回复，重试使用原问题版本。取消使未回答问题过期，恢复过程报告中断而不启动新的 Agent。[状态与接口](../../docs/state-and-api.zh.md)定义兼容性和回复身份。

调度进程维护与任务接收共用串行机制。`beginMaintenance` 要求不存在等待、计划、执行或服务中的任务，也没有未确认释放的资源；操作身份阻止其他调用者解除维护状态。[controller-protocol.ts](src/controller-protocol.ts) 校验 GPU 观测、进程身份和经过认证的维护请求，不改变实验提交或 Session 数据。

-----

<a id="understand-the-implementation"></a>
## 了解实现

[interruption.ts](src/interruption.ts) 定义独立版本 1 操作回执，不修改提交、fleet 或 Session 代次。队列终态拒绝会恢复已结束任务的迟到更新；释放核验保留已有终态结果。[受控中断](../../docs/state-and-api.zh.md#experiment-interruption)说明公开字段、节点证据与历史保留。

[archive.ts](src/archive.ts)公开版本 1 本机副本状态及来源可用性，与实验结果独立。[本机运行记录](../../docs/state-and-api.zh.md#local-running-records)说明持久化类型确认及使用方；现有提交、Session 事件和执行步骤文件保持原格式。

[execution-progress.ts](src/execution-progress.ts)导出独立第 1 代步骤上报及读取／结果定义。记录绑定实验、批准的计划版本和执行 Session，调用身份及时间由程序提供。[步骤进度](../../docs/state-and-api.zh.md#execution-step-progress)说明持久化、版本冲突及兼容规则，现有队列记录和计划保留原格式。

第 4 代固定简短实验名称及三个阶段的模型配置摘要，保留第 1～3 代读取定义。[records.ts](src/records.ts) 定义实验／阶段／Session 分页以及节点／进程／输出流游标。首次等待计划确认时保持资源释放，确认后才整组分配。

<details>
<summary>实现细节</summary>

[environment-protocol.ts](src/environment-protocol.ts) 定义不含凭据的程序探测及已验证路径。连接探测可在安装 Node 前报告环境未就绪，使用方分别处理可选磁盘清单和 SSH 可达状态。

[cluster-protocol.ts](src/cluster-protocol.ts) 冻结第 1～3 代读取定义并声明第 4 代提交；[storage-protocol.ts](src/storage-protocol.ts) 分开定义偏好、SSH 证据及实际目录。[cluster-queue.ts](src/cluster-queue.ts) 管理持久状态转换和提供者生命周期。[cluster-files.ts](src/cluster-files.ts) 限制读取范围及大小。接收时检查实验／节点／发布归属与资源分配，不发布单独的存在性 invariant。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [启动工程](../../README.zh.md)
- [节点提供方](../runtime/README.zh.md)
- [数据和接口版本](../../docs/state-and-api.zh.md)

<a id="model-experience"></a>
## 模型体验

可选清理及恢复字段提供独立版本 1 `EnvironmentCleanup` 与 `EnvironmentRecovery` 记录；缺少这些字段的原回执及观察继续可读。诊断中的挂载 ID 只说明一次检查，不授权后续操作。

[受管环境类型](src/managed-environment.ts)定义独立版本 1 清单、包身份、引用、复用计划、启动证据和候选绑定清理请求。空间观察可选包含复用计划及带时间的材料描述，清理区分包、材料和临时文件。协议 4、本机存储域 6 和 Session 格式保持固定；[环境归属](../../docs/managed-environments.zh.md#recovery-and-compatibility)说明引用保留与消费者。

`EnvironmentRuntime` 记录操作原期限、停止原因和独立退出/释放观察；`EnvironmentRequirements` 将生效的合并约束绑定到原请求摘要。`EnvironmentOperationStatus` 校验认证轻量读取与最终工具结果，空间观察可选包含这些带时间的状态。两种新增持久记录均使用版本 1，不改写原回执。

可选的 `EnvironmentOperation.failure` 包含版本 1 `EnvironmentFailure` 证据，绑定实验、节点、环境、请求和原冲突 wheel 身份。被拒绝的重试引用原操作，不改写原回执。`EnvironmentReusePlan.installerTemporaryBytes` 可选记录专属工具的临时占用；缺少这两个字段的旧记录继续可读。

间接影响：运行时和派发工具展示本库验证的记录，本库不注册工具或模型消息。

独立的[版本 1 完成记录](src/completion.ts) 描述来源身份、历史环境及回顾验收。[完成验收](../../docs/completion-review.zh.md) 说明持久记录和兼容性变更确认；原执行记录、协议 4 和 Fleet 存储域 6 均不变。

[收尾记录](src/finalization.ts)和[批准阶段](src/stage-requirements.ts)将数值验收、命令等待、结束判定和历史步骤补录绑定原实验、计划及 Session。[记录与兼容](../../docs/finalization.zh.md#records-and-compatibility)确认独立版本 1 文件及可选计划字段的持久类型变更，原步骤文件和 Session 格式不变。

[存储记录](src/storage-governance.ts) 声明带品牌的候选／操作 ID、目录索引、历史借用、逐卷计划、正式材料、绑定与最终退出回执。存储观察的可选字段及所选清理 ID 保留原读取数据。独立版本 1 持久记录及生成消费者变更见[存储治理确认](../../docs/storage-governance.zh.md#records-and-compatibility)；协议 4、fleet 第 6 代和 Session 格式不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 一个调度主机负责接收，不提供自动主机切换或共识协议。
- 提供方必须确认进程退出，结果不明时资源继续占用。
- 文件按需读取，清单数量由调用方指定限制。

### 开发备注

无。
