---
kind: upgrade-guide
description: "Aspera 阶段 Agent 在私有模型环境中使用 DSH 压缩，未完成的 token 上限停止转为受阻。"
---

# Aspera 阶段 Agent 上下文

[English](guide.md) | 中文

## 变更

Aspera 的准备、规划和执行 Agent 在各阶段保存的模型环境中挂载已发布 DSH 的上下文压缩及工具结果裁剪。worker 根级压缩器无法解析 `qwen-chat` 等仅属于实验的提供商，因此禁用。`agentContext.compaction` 和 `agentContext.pruning` 通过 DSH 的校验规则与默认值配置阶段服务。摘要配置必须指向实验保存的提供商和模型，包括匹配的模型策略覆盖项；冲突配置会拒绝创建 Agent。

规划或执行回合在完成前以 `max-tokens` 结束时，持久保存受阻 Goal 和 worker 终态结果，避免 Agent 空闲但实验仍显示运行中。调度端保留受管进程核对，不重放命令。协议 4、fleet 第 6 代、批准计划、硬件要求和 Session 格式保持不变。

## 迁移

1. 同步更新应用资源及运行时依赖。桌面资源更新器保留现有可执行文件。自定义调用者可向 `openPhaseModelContext` 或 `ExperimentFleet.open` 的 `agentContext` 参数传入已解析的 `PhaseContextPolicy`；省略时使用已发布的默认值。
2. 在管理 profile 的 `aspera-dispatch.agentContext` 配置准备阶段。在 `aspera-runtime.agentContext` 配置远端阶段；调度进程通过 `DSH_CLUSTER_CONTEXT_POLICY_JSON` 将解析后的设置传给 worker 子进程。保留阶段私有凭据，移除冲突的摘要提供商／模型覆盖项。参见[上下文配置](../../../../extensions/aspera/packages/runtime/README.zh.md#use-this-package)。
3. 已提交实验保留原固定发布。资源更新不重启旧 worker，也不改写其结果。确认旧任务已释放后，复制实验以部署修复后的运行时；历史数值计算失败单独调查。
4. 通过[无密钥 worker 回放](../../../../extensions/aspera/scripts/test-worker.mjs)验收：长上下文通过私有选定模型生成真实 `compaction/summary` 事件，后续工具继续执行，已结束命令只启动一次。token 上限响应写入 `aspera-model-token-limit` 并退出。真实长时间 GPU 训练仍需单独验收。
