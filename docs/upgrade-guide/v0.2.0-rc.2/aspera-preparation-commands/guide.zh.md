---
kind: upgrade-guide
description: "Aspera 准备命令统一下载期限，并在 SSH 中断后保留受管退出结果、完整日志及可复用的 uv 材料。"
---

# Aspera 准备命令恢复

[English](guide.md) | 中文

## 变更

已具备 Python 时，准备 Host 独立于 SSH 监督命令。命令及下载重试共用 `toolTimeoutMs`，并受安装轮次剩余期限约束。重新连接读取原命令；已确认退出的超时将诊断返回原 Agent，继续修复。退出证据缺失仍阻止修改。仅有 Shell 时，Python 引导使用系统 `timeout` 工具和直接日志文件。

`prepare_preparation_tool` 通过已验证程序、wheel 及未完成下载的复用，配置发布要求的固定 uv，并返回供程序复验的路径。旧训练环境与固定发布保留。独立版本 1 的准备及材料记录保存身份和日志；提交协议 4、本机 fleet 第 6 代及 Session 格式保持不变。

## 迁移

1. 同步更新 Host 资源和生成类型。保留原 EXE、实验 ID、准备 Session、发布与命令目录。准备重试先核对保存的命令，再允许新修改；不能通过删除待核验记录绕过未知退出。
2. 核对 `preparationCommandReadTimeoutMs`、`preparationCommandRecoveryTimeoutMs` 和 `preparationCommandStopGraceMs`，默认分别为 30000、60000 和 5000 毫秒。轮询复用 `pollIntervalMs`，上限为 10000 毫秒。下载及所有内部重试必须遵守 `ASPERA_PREPARATION_REMAINING_MS` 和 `ASPERA_PREPARATION_DEADLINE_MS`。
3. 配置 uv 时，先调用 `prepare_preparation_tool`，再考虑自定义下载。保留其服务器缓存及未完成材料。将返回目录传给 `verify_preparation_environment`；安装文字或下载成功不能替代就绪验收。详见[准备命令恢复](../../../../extensions/aspera/packages/dispatch/README.zh.md#preparation-command-recovery)。
