---
kind: upgrade-guide
description: "Aspera 固定发布新增 uv 要求、受管环境工具、独立记录与空间接口。"
---

# Aspera 受管训练环境

[English](guide.md) | 中文

## 变更

Aspera 新发布固定 uv，通过范围限定的工具安装依赖，并只读挂载共享包内容。受管执行禁用 `.local` 安装。清单、引用和回执使用独立版本 1 文件，本机保存带时间的空间观察。协议 4、本机存储域 6、Session 格式及原提交内容保持不变。

`managed-environment-install-v3` 和 `installVersion: 3` 要求匹配控制进程并固定 `pipVersion`。独立工具环境和包冲突记录阻止未修复的重复安装。`create` 合并直接要求，`install` 替换要求。已验证 wheel 别名在失败后保留。安装等待回执、退出及准入释放；轻量 `operation_id` 读取保留原期限。消费者读取其中的 `operation`，`operationReconnectTimeoutMs` 默认 60000。

`managed-environment-reuse-v1` 在安装前检查已验证材料。解析结果与启动记录在失败后保留；包内容共享链接，元数据保持独立。恢复不能仅凭旧记录缺失推断退出。

`AsperaRemote` 增加空间接口，需重新生成消费者。`ExperimentFleet.open` 在 `agentContext` 后接受可选 `ManagedEnvironmentPolicy`。固定发布继续保留。

## 迁移

`storageFormat: "0.1.0"` 要求 `purpose-storage-0.1.0`；[存储治理](../../../../extensions/aspera/docs/storage-governance.zh.md#records-and-compatibility)定义位置安排兼容方式。资源同步更新，已有任务保留原发布和目录。

`storageVersion: 1` 要求 `storage-governance-v1`、`historical-environment-borrow-v1` 和 `managed-materials-v1`。[存储治理](../../../../extensions/aspera/docs/storage-governance.zh.md) 定义预算、已验证借用、唯一 wheel 保留、所选清理及固定材料。配置 `managedEnvironments.governance`，更新计划／刷新消费者。传输默认两小时、每服务器一个。独立版本 1 记录保留 fleet 和 Session 格式。释放旧任务后复制实验，保留封闭发布及硬件要求。

能力 `managed-environment-cleanup-v1` 与清单 `cleanupVersion: 1` 要求复用控制进程前确认按真实挂载身份清理。独立版本 1 清理与恢复记录区分已验收发布和普通临时删除失败；待清理残留保持隐藏并保留引用，安全错误和未知退出仍阻塞。恢复保留已确认退出的原失败回执，仍需再次程序复验。现有封闭发布不能原地获得此行为；先释放旧任务，再复制实验。

1. 使用桌面资源更新器同步更新构建后的 Host、runtime 和 Web 资源，保留现有可执行文件及原安装发布。旧实验需要新工具时，先确认资源释放，再复制为新实验。
2. 配置本机及远端 `managedEnvironments` 上限。`uvVersion` 和 `pipVersion` 必须与固定清单的 `asperaEnvironmentTools` 版本一致。启动旧发布时省略 pip 配置，且不能复用 v3 安装器；更换控制进程需受控空闲修复。节点通过 `DSH_CLUSTER_ENVIRONMENT_POLICY_JSON` 接收配置。
3. Agent 在 `training` 中请求实际依赖和导入，安装工具内部等待。失败或结果未决后检查、恢复原操作并复验。修改前停止环境使用者，确认重复准备不下载匹配包。
4. 使用[空间预览与清理](../../../../extensions/aspera/docs/managed-environments.zh.md#space-and-cleanup)。删除本机记录保留远端引用，确认远端删除后才释放。未知引用、活动进程及预览摘要变化均阻止回收；不改写已有环境或缓存。
5. 验证 Linux 文件系统回归、无密钥 worker 回放和 Web 空间/清理用例。服务器或 CUDA 不可用时分别记录，CPU 样本不能代替 GPU 验收。
