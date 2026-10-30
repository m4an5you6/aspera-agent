---
kind: upgrade-guide
description: "Aspera 命令等待真实退出，训练阶段按批准口径验收，历史受阻结果支持受限补录。"
---

# Aspera 阶段验收与实验收尾

[English](guide.md) | 中文

## 变更

命令工具等待真实终态及清理。`run_experiment_command_group` 先启动全部分布式成员再等待，无需模型轮询。取消观察和传输失败不能证明退出。

命令重试要求内容和用途一致，格式 `0.1.4` 的等待记录保存对应信息，认证节点状态核对后才接受退出结果。旧等待记录继续可读，缺失身份不能确认新请求。`asperaEnvironmentTools.commandIdentityVersion: 1` 要求 `command-wait-identity-v1`。命令变化时使用新运行 ID，旧发布保持固定。

使用 `read_experiment_file(command_id, stream, offset, generation?)` 读取返回的 stdout/stderr 引用；诊断没有猜测的工作区日志。`finalization.commandOutputBytes` 默认为 8192，可选的 `ProcessLogRequest.limit` 限定传输页大小。发布清单的 `asperaEnvironmentTools.commandOutputVersion: 1` 要求 `command-output-v1`。持久输出流和 Session 格式不变。

训练计划在批准前声明阶段，启动前登记生效参数和证据。程序分别检查新增／累计步数、指标覆盖、样本数及恢复的 scheduler。全部 finish 请求核对真实工作；未核实阻塞先获得 `finalization.reasonCorrections` 次纠正机会，之后记录 Agent 工作未完成。

已释放且原训练及收尾证据得到独立确认的 blocked 实验可以申请受限补录。原结果及步骤文件保持不变，只有独立通过回执才能显示复验通过。补录不能训练、评估或生成推理结果。


`asperaStageAttemptVersion: 1` 要求 `stage-attempt-recovery-v1`。确认原命令失败并释放后，`register_experiment_stage` 接受 `previousAttemptId`、新的尝试／命令 ID 及独立结果路径。不可变后继记录保留原登记和检查结果。运行中、已成功或退出未确认的尝试不能被替换。先检查重试资格，再给出路径指引。批准参数和恢复来源保持固定；历史补录不能重试训练。

`asperaStageEvidenceVersion: 4` 要求 `stage-checkpoint-evidence-v4`，并保留旧读取与验收能力。原生关联要求状态完整字节、大小及 SHA-256 一致；结果保留实际 adapter 路径。保存与保留检查依据原生目录，不依赖日志副本位置。旧清单保持可读。

`asperaAgentRecoveryVersion: 1` 要求 `agent-recovery-v1`。`finalization.outputTokenCorrections` 默认在同一 Goal／Session 中允许连续恢复输出上限两次，收到工具结果后重新计数。纠正信息写入日志，不重放命令。旧发布不会接收此配置项。

## 迁移

`asperaCheckpointProtectionVersion: 1` 要求 `checkpoint-protection-v1`。批准的恢复文件组在产生进程成功退出后只读，写入未结束时拒绝并发修改，身份变化时阻止修改。保留成功 checkpoint，修正证据而不重训。确认资源释放后，复制新实验使用保护，旧任务保持固定。

1. 为 `experimentCompletionAssessment` 和 `experimentFinalizationStatus` 重建 Remote 消费者。默认值不适用时，通过 profile 调整 `finalization` 的轮询、读取／重连预算及纠正次数。
2. 使用 `asperaFinalizationVersion: 2` 且声明上述尝试／证据能力的发布，准备阶段核对控制进程兼容性。保留旧实验及其固定发布。
3. 为 Transformers/ms-swift/PEFT 阶段明确累计／新增步数及 scheduler 语义。使用等待命令工具替代模型轮询日志，常驻服务继续使用专用工具。
4. `recoverExperimentAcceptance(id, recoveryId?)` 将现有推理恢复关联到原生 checkpoint 与公网检查。来源预览增加提供文本摘要及脱敏状态，观察超时使用 `finalization.reconnectTimeoutMs`。仍须完整复验原任务，不重跑已完成训练。[独立恢复记录](../../../../extensions/aspera/docs/completion-review.zh.md#recover-acceptance-on-the-original-experiment)保留原结果、协议 4、fleet 6 和 Session 格式。
