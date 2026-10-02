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

通过角色配置选择 `coordinator`、`node`、`planner` 或 `agent`，根目录、token 路径、发布及实验身份由部署提供。Config 限制轮询、清理、文件数量、字节块及 HTTPS 文档域名和大小；准确值及默认值见 [Config](src/index.ts) 和 patch。启动常驻节点 profile 前配置设备、隔离程序及隐藏路径。

普通命令在取消清理后不能继续运行。协议第 `2` 代的命令和服务没有总时长或总命令数上限，旧资源分配保留原发布限额。登记的服务具有独立进程身份，保留完整实验资源，并在执行 Agent 完成后继续运行。端口已占用时拒绝启动，成功要求受管进程保持存活且 HTTP 接口通过健康检查。服务观察不会重新启动失败进程。

`goalContinuationWindow` 是部署设置，默认 `128` 轮；worker patch 通过 `DSH_CLUSTER_GOAL_WINDOW` 配置。续行插件在有限窗口耗尽前通过公开 `Goal.edit` 延长同一 Goal。每次延长都记入日志，并非用户任务预算。连接、探测和模型单次操作超时、循环保护、沙箱和取消仍然生效。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

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
- 固定 worker profile 必须配置所选提供方，选择模型不会移交任意提供方插件或设置。
- 节点重启后结果不明时，需要操作人员核对，不提供强制释放或自动重启训练。
- 多 Agent 算法和 RSI 优化管线由其他扩展实现。

### 开发备注

无。
