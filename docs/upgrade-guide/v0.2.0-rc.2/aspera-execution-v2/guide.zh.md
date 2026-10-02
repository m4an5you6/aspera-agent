---
kind: upgrade-guide
description: Aspera v2 提交移除任务总预算，并增加持久化的人工回复。
---

# Aspera 执行协议 v2

[English](guide.md) | 中文

## 变更

独立 Aspera 扩展从 0.1 升至 0.2，已发布的 DSH 依赖版本保持固定。新提交使用协议 2。两种执行模式均不再包含任务总时长、命令总次数、Goal 总轮数和推理服务总时长预算。移除 `defaultBudget`、`budget_json` 和四项 `defaultMax*` 派发配置。半自动模式能够持久化问题，并通过 `answerExperimentQuestion` 接收回复；全自动模式不等待用户回答。

协议 1 的提交及其摘要仍可读取，原发布版本和限额继续有效。中断实验只报告状态，不重新启动训练；未解决的问题过期。新运行时拒绝按新策略执行旧提交。

桌面构建输出完整的 `win-unpacked` 应用目录和构建记录，不再生成 ZIP。

## 迁移

1. 在旧远端版本上完成或取消实验，确认节点清理后再停止其控制进程。将新版本安装到独立的内容寻址目录。不要替换忙碌的控制进程，也不要删除旧版本和状态。
2. 更新 `createExperiment` 和 `dispatch_experiment` 调用，移除预算字段。从自定义派发配置中移除 `defaultMaxRuntimeSeconds`、`defaultMaxServiceSeconds`、`defaultMaxCommands` 和 `defaultMaxGoalRounds`。
3. 如有需要，设置远端运行时的 `goalContinuationWindow`。它是续行窗口，不是任务总上限。保留单次操作超时和隔离。
4. 重新构建 Aspera 及生成的 Remote 描述。确认新回执包含 `protocol: 2`，半自动回复恢复同一个 Session 和 Goal，并确认 v1 回执仍显示原有限额。
5. 直接打开 `win-unpacked/Aspera.exe`，完整保留该目录内所有文件。使用[桌面 API 检查](../../../../extensions/aspera/docs/verification.zh.md#local-checks)，在仓库外的状态目录验证内置插件解析。

启动与验收命令见 [Aspera 工作区](../../../../extensions/aspera/README.zh.md)。
