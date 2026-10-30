---
kind: upgrade-guide
description: "Aspera 公网推理检查由本机 Host 使用私有凭据和可持久恢复的单次请求执行。"
---

# Aspera 公网推理验收

[English](guide.md) | 中文

## 变更

执行 Agent 登记并确认公网服务本地健康后，调用 `verify_inference_service`。本机 Host 使用固定无敏感提示验证保存的公网映射；节点路由失败不能替代 Host 观察。凭据不进入 Agent 输入和日志。完成实验要求真实的服务身份、认证、模型清单及生成检查。

网关保留已核验的固定请求长度及未知长度的流式传输，并限制声明和实际请求体大小。

Host 的 `publicServiceVerificationRoute` 默认为 `direct`，请求专属连接保留全局代理设置；`inherit` 沿用现有 HTTP 代理策略。TLS 和 Bearer 检查仍为必需。传输失败保留有限长度的原因代码，路由变化不会重放已保存或结果未决的生成请求。

持久类型确认：独立版本 1 的 `ServiceVerification` 记录绑定原请求、服务命令、模型、发布、期限及 Host 认领。远端记录和本机已提交结果副本均可跨重连恢复。生成回复丢失时保持未决，恢复不重新发送生成请求。记录纳入归档和实验清理。无需迁移 Session、协议 4 或 fleet 第 6 代。

私有执行结果同时保存进入服务状态的服务器／服务身份，用于恢复监控。监控忽略先前失败尝试，仍保留已接纳服务的失败；无法确认接纳身份时保留占用。旧固定发布保持不变。

## 迁移

推理页面显式获取密钥，默认 PowerShell 示例使用 `ConvertTo-Json` 和 `Invoke-RestMethod`，保留 cURL 选项。替换 `YOUR_API_KEY` 或选择“复制命令（含密钥）”，普通复制保留占位。直接调用模型执行生成，服务健康检查探测网关。管理菜单确认停服，已释放尝试进入历史。两个服务入口对原实验／恢复任务去重，保留观察时间，无需迁移远端或记录。

状态读取失败后仍可显式获取密钥，并保留连接错误。桌面复制要求自有页面的剪贴板权限。完全退出 Aspera 后应用[桌面脚本更新](../../../../extensions/aspera/apps/desktop/README.zh.md#build-and-verify)，保留可执行文件和运行时归档。剪贴板读取和其他页面仍被拒绝。

执行 Agent 同时具备 `stop_inference_service`。确认 `released=true` 后，以新的服务 ID 启动修正代码。停服保留 checkpoint 和日志，重复旧启动请求不会重启该服务。这沿用既有协议 4 服务记录。桌面更新后，运行中的 Agent 仍使用原固定工具。

独立推理恢复使用 `inspect_inference_checkpoints` 和 `prepare_inference_checkpoint`，从已释放、已封存的原生 adapter 创建只读硬链接快照。独立版本 1 的 `InferenceCheckpointSnapshot` 记录绑定来源身份、摘要及发布恢复；归档／删除保留原结果、Session 和 fleet 代次。

1. 使用声明 `asperaServiceVerificationVersion: 1`、`asperaServiceLifecycleVersion: 1`、`asperaInferenceCheckpointVersion: 1` 及对应能力 `public-inference-verification-v1`、`inference-service-lifecycle-v1`、`inference-checkpoint-snapshots-v1` 的发布；准备阶段在复用前核对控制进程兼容性。
2. 更新全部工具与记录消费者，保持公网服务凭据私密。原服务 API 返回类型保留。
3. 保留旧发布与结果。确认资源释放后再复制实验使用新工具。等待、记录与恢复规则见[公网推理验收](../../../../extensions/aspera/docs/public-inference.zh.md)。
