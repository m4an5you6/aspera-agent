---
kind: upgrade-guide
description: "Aspera 后台复制分别使用正常、积压和等待间隔，并在检查时保留上次结果。"
---

# Aspera 记录保存间隔

[English](guide.md) | 中文

## 变更

管理 profile 的 `archiveIntervalMs` 默认值从 2000 改为 15000 毫秒。`archiveBacklogIntervalMs` 默认为 5000，`archiveWaitingIntervalMs` 默认为 30000。`archiveRetryMinMs` 从 5000 改为 10000，最大值仍为 60000。间隔从上一轮结束后计算。终态资源释放且当前尾部复制完成后停止自动读取，历史缺口继续保留。

`lastSyncedAt` 记录最近成功轮次，包括没有新增字节的检查。后台检查保留上次结果，不在开始时发布 `syncing`。既有状态字段及索引版本仍可读取；`incomplete` 仍表示历史缺口。界面在概览右侧的“记录保存”卡片中单独展示这些缺口。

活动阶段在队列保存其 Session id 前即可归档事件。读取器使用唯一且归属已核验的实验／节点 Agent 来源声明；声明缺失时保持不可用，有歧义时返回诊断。已保存的队列身份仍为准。Session、远端发布和归档代次保持不变。

## 迁移

1. 重新构建并启动管理 profile。检查其中 `aspera-dispatch` 配置显式覆盖的归档间隔；已有值仍优先生效。自定义 fleet 调用者若传入解析后的归档策略，须包含 `archiveBacklogIntervalMs` 和 `archiveWaitingIntervalMs`。
2. `lastSyncedAt` 的消费者须将其视为成功检查时间，而非新增输出的证据。通过 `savedBytes` 和来源游标判断复制内容。独立于当前同步活动读取 `gaps` 及来源缺口。
3. 确认右侧卡片在后台工作期间保留时间、独立展示历史缺口，并在最后复制完成后仍允许“立即同步”。配置和归属规则见[本机运行记录](../../../../extensions/aspera/docs/state-and-api.zh.md#local-running-records)。
