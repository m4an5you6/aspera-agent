---
kind: upgrade-guide
description: "Aspera 命令等待真实退出，训练阶段按批准口径验收，历史受阻结果支持受限补录。"
---

# Aspera 阶段验收与实验收尾

[English](guide.md) | 中文

## 变更

普通命令工具等待真实终态及清理。分布式成员使用 `run_experiment_command_group`，先启动全部成员再等待。不需要额外模型请求轮询日志。取消观察和传输失败不能证明进程退出。

训练计划在批准前声明结构化阶段。启动前登记生效参数和证据路径，再请求程序验收。新增与累计优化器步数、指标覆盖、样本数及恢复的 scheduler 分别检查。全部 finish 请求核对真实工作与记录，无证据预算理由要求纠正。

已释放且原训练及收尾证据得到独立确认的 blocked 实验可以申请受限补录。原结果及步骤文件保持不变，只有独立通过回执才能显示复验通过。补录不能训练、评估或生成推理结果。

## 迁移

1. 为 `experimentCompletionAssessment` 和 `experimentFinalizationStatus` 重建 Remote 消费者。默认值不适用时，通过 profile 调整 `finalization` 的轮询、读取／重连预算及纠正次数。
2. 使用声明 `asperaFinalizationVersion: 2` 和 `experiment-finalization-v2` 的新发布，准备阶段核对控制进程能力。保留旧实验及其固定发布。
3. 为 Transformers/ms-swift/PEFT 阶段明确累计／新增步数及 scheduler 语义。使用等待命令工具替代模型轮询日志，常驻服务继续使用专用工具。
4. 依据原文件、命令及 Session 证据复验符合资格的历史结果。保留 checkpoint、日志和原结果，不为补录重跑已完成工作。独立版本 1 记录及持久类型变更确认见[阶段验收](../../../../extensions/aspera/docs/finalization.zh.md)。提交协议 4、fleet 6 及 Session 格式不变。
