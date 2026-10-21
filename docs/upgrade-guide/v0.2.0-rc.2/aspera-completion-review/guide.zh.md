---
kind: upgrade-guide
description: "Aspera 完成操作要求逐节点执行证据，并新增保留原结果的独立历史复验。"
---

# 完成与复验 Aspera 实验

[English](guide.md) | 中文

## 变更

完成工具和最终收尾现在共用逐节点检查。执行 Agent 遗漏 `record_experiment_execution` 时，Goal 保持活动并收到缺失字段。应根据已有脚本、环境、参数和结果补录，不得重复已结束的工作。

因完成证据缺失而失败且已释放资源的实验提供“补录并重新验收”。标准受限 DSH Agent 使用原执行模型和独立 Session，不能训练、安装或启动服务。程序验收回执显示“复验通过”，原失败和时间继续保留。已有 `pyenv` 元数据可以只读登记，仅用于该历史复验。

补录 JSON/JSONL 证据与嵌套事件在移除凭据后保留有效结构，补录诊断一次列出全部不匹配项。补录轨迹异步读取本机原 DSH Session，因此脱敏副本损坏不会遮蔽完整历史，也不需要再次启动复验。

## 迁移

1. 重新生成 Remote 客户端，接入 `reviewExperimentCompletion`、`experimentCompletionReviewStatus`、`cancelExperimentCompletionReview` 和 `experimentCompletionReviewTrace`。
2. 保留原提交、固定发布、Session、环境、产物和日志。新发布声明 `asperaCompletionVersion: 1` 和 `completion-evidence-v1`，准备时核对控制进程能力。历史复验不替换旧发布。
3. 打开符合条件的失败实验，请求补录并查看独立轨迹。全部原节点重新可达后，核对文件、命令释放和来源摘要。缺少证据继续受阻，取消只影响补录。
4. 刷新更新后的应用，从保留的 Session 恢复已有补录轨迹；损坏副本保留用于诊断。不要重启已通过的复验。确认带时间的“复验通过”回执及保留的原失败。独立版本 1 复验、来源和历史环境记录见[完成验收说明](../../../../extensions/aspera/docs/completion-review.zh.md)。提交协议 4、Fleet 存储域 6、现有执行记录和 Session 格式均不变。
