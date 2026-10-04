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

-----

<a id="understand-the-implementation"></a>
## 了解实现

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

间接影响：运行时和派发工具展示本库验证的记录，本库不注册工具或模型消息。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 一个调度主机负责接收，不提供自动主机切换或共识协议。
- 提供方必须确认进程退出，结果不明时资源继续占用。
- 文件按需读取，清单数量由调用方指定限制。

### 开发备注

无。
