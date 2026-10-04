---
kind: upgrade-guide
description: "Aspera 要求指定实验调度主机，写入第 6 代本机记录，并提供显式管理操作。"
---

# Aspera 实验与服务器管理

[English](guide.md) | 中文

## 变更

Aspera 保持 `0.1.1`，DSH 保持 `0.2.0-rc.2`。新建实验请求和派发工具分别要求提供 `coordinatorId`、`coordinator_id`，且必须指向选中的节点。服务器不再按注册顺序永久承担调度角色。同一管理 profile 内，不同调度主机的未结束实验不能使用重叠节点；同调度主机继续排队。首次等待计划确认不分配 GPU。

本机 `aspera_fleet` 写入第 `6` 代，读取第 `1`～`5` 代，保存与配置绑定的检查结果、删除进度和删除标记。远端协议、远端存储及 Session 格式不变。旧任务保留原调度主机、目录、凭据和请求摘要。持久化变更确认见[状态与接口](../../../../extensions/aspera/docs/state-and-api.zh.md)。

`probeServer` 返回结构化检查结果，单独保留带时间的最近成功信息。编辑器显式调用 `revealServerPassword` 才会返回已保存密码；常规查询不返回密码。删除预览和批量操作永久移除符合条件的记录，可选清理专属文件，不设回收站。自定义 `FleetDriver` 必须实现 `cleanupServerStorage`。

## 迁移

1. 安装匹配的 Host 和客户端构建，重新生成 Remote 消费者。每个创建请求和工具调用都必须指定所选节点中的调度主机，不从注册顺序推断。
2. 保留现有 fleet 和远端目录，确认历史实验仍显示原调度主机。管理 profile 写入第 `6` 代后不要降级。
3. 检查结果消费者改为读取 `status`、`checkedAt`、`configuration`、`result` 和 `lastSuccess`，独立显示失败或中断状态与历史硬件信息。
4. 删除前先停止实验并确认进程及资源释放。选择远端清理前预览准确的节点目录。部分失败时沿用操作标识重试，或使用新标识明确改为只删除记录。保留原始文件、普通 DSH 会话及共享远端状态。
5. 为自定义驱动实现经过校验的专属目录清理操作。按[本地验证流程](../../../../extensions/aspera/docs/verification.zh.md)检查连接、密码显隐、删除记录及实验调度选择。
