---
description: "经过认证的回环地址接收端，管理远端无人值守实验 Goal 和持久回执。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experiment-worker

[English](README.md) | 中文

## 概述

`experiment-worker` profile 在 Linux GPU 目标上作为独立 DSH 进程运行。经过认证的回环地址 HTTP 接口接收一项实验，创建自己的 Session 和 Goal，并在确认接管前保存回执。该进程及其 Agent 不依赖派发时使用的 SSH 隧道。

## 目录

- [使用](#use-this-package)
- [实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用

派发端使用私有 Harness home、工作目录、部署源码摘要、分配的 NVIDIA 设备路径、令牌文件和回环地址端口启动 `dsh --profile experiment-worker`。该 profile 禁用人工提问、交互式计划审批、插件管理和进程内文件工具；审批策略拒绝提权。bwrap 沙箱保持 `workspace-write` 模式，只授予配置的 NVIDIA 字符设备，并在命令进程内遮蔽工作端的凭据和状态目录。常见 Python 和模型缓存位于可写的实验工作目录内。

接收端通过现有 WebServer 服务，在 `/experiment/v1` 下提供需要认证的健康检查、提交、状态、取消与空闲停止操作。Bearer 令牌及该版本专用的模型凭据都从仅所有者可读的文件读取，不进入 Goal 文本。提交内容包括按摘要识别的部署版本、提交编号和明确的实验要求。输出目录和数据引用必须位于工作目录内。

健康响应必须包含 SHA-256 格式的 `deploymentId`、`ready: true` 和布尔值 `busy`，不允许其他字段。派发端在复用准备记录、启用版本或恢复先前工作端之前校验这些字段。忙碌的工作端接受状态查询和重复提交，但拒绝替换部署。

状态包含持久回执、Agent 运行时的 Goal 阶段、工作进程日志是否存在，以及最多 128 个相对产物文件路径和大小。截断标记表示还可能有更多文件。

<a id="understand-the-implementation"></a>
## 实现

<details>
<summary>实现细节——点击展开</summary>

存储域在创建 Agent 前预留提交编号。接收端创建并启动 Goal，记录机器来源的初始消息，刷新 Session 到持久存储，然后确认接管。同一编号、相同内容的并发和重复请求返回同一记录；内容变化则冲突。终态在 Agent 空闲并刷新 Session 后保存。进程启动时将尚未结束的记录标记为 `interrupted`，不重新开始训练。

</details>

<a id="further-exploration"></a>
## 进一步阅读

部署和提交由[派发端](../experiment-dispatch/README.zh.md)负责；续行状态见 [Goal 服务](../../goal/goal/README.zh.md)，生命周期归属见[接管决定](../../../.agents/notes/implemented/architecture/2026-09-23-independent-gpu-experiment-handoff.zh.md)。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Session 日志拥有 Goal 状态；存储记录拥有提交身份和接收生命周期。两者不是彼此的重复投影，因此本包不发布单独的 invariant。

</details>

<a id="model-experience"></a>
## 模型体验

### 实验消息

#### What the model sees

远端 Agent 收到已记录的 `experiment-worker` 插件消息，包含目标、明确的模型和数据要求、输出目录，以及仅补全未指定设置的指令。它必须等待受管理训练任务的真实退出结果，再完成 Goal。

#### Token effect

消息将随任务变化的要求加入远端第一次模型请求，并保留在对应 Session 历史中。

#### KV Cache effect

实验内容变化会改变该 Session 的初始请求前缀；重复提交已接管的同一任务不会再追加消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

派发端在接收端启动前构建源码并探测 CUDA；运行时仍有以下限制：

- 每个目标只能同时运行一项实验。
- 工作进程重启后会报告中断，不自动重启训练。
- 取消操作管理受控任务和子进程；刻意脱离 DSH 进程管理的程序不会被追踪。
- 文件沙箱不提供完整网络隔离。
