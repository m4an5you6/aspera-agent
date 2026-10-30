---
kind: upgrade-guide
description: "Aspera 已认证 wheel 元数据修复与显式包管理器缓存回收。"
---

# Aspera 输入 wheel 修复与缓存回收

[English](guide.md) | 中文

## 变更

`asperaEnvironmentTools.wheelMetadataRepairVersion: 2` 要求 `managed-wheel-metadata-v1`/`managed-wheel-metadata-v2`；`managerCacheVersion: 1` 要求 `managed-manager-cache-v1`。旧控制进程须经受控空闲维护后才能复用或交接。

提交的本地 wheel 地址需要已认证输入证明。Agent 显式选择修复计划及 `repairWheelMetadata: true`；程序仅对支持的元数据差异创建独立构建。原输入及可执行载荷保持不变，运行验收仍然必需。

清理新增 `manager-cache` 候选。仅显式选中、空闲且无引用的已知缓存允许固定包管理器回收。预览过期时，将具体原因保存为受阻回执；刷新预览并使用新操作 ID。

`inputSharingVersion: 1` 要求 `managed-input-sharing-v1`。清理及 schema 消费者接收 `input-duplicate`；Agent 显式选择后，仅合并原任务与资源已可靠释放、认证内容相同的输入快照。当前可写输入保持排除。原路径、字节和权限身份保留；独立 `input-sharing-v1` 回执保存原时间及替换记录。

`releaseAssetSharingVersion: 1` 要求 `managed-release-asset-sharing-v1` 和 `release-asset-duplicate` 清理类型。显式选择后，仅合并非活动封闭发布中内容相同且不可变的 LibreOffice/终端资源，保留全部路径与字节。选定发布、进程使用和外部别名保持排除；版本 1 的 `release-asset-sharing-v1` 回执纳入归档。

## 迁移

更新工具、类型及生成的 Remote 消费者。旧实验继续固定原发布，释放后再复制新实验；原环境、模型、数据、结果及日志保留。独立版本 1 输入证明、派生记录和缓存回执纳入归档，协议 4、fleet 6 和 Session 格式不变。参见[受管环境](../../../../extensions/aspera/docs/managed-environments.zh.md)。
