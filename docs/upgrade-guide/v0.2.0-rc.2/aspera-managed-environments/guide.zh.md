---
kind: upgrade-guide
description: "Aspera 固定发布新增 uv 要求、受管环境工具、独立记录与空间接口。"
---

# Aspera 受管训练环境

[English](guide.md) | 中文

## 变更

`wheelMetadataRepairVersion: 2`/`managerCacheVersion: 1` 要求[已认证元数据修复与缓存回收](../aspera-wheel-metadata/guide.zh.md)。

`readonlyConsumerVersion: 2` 要求 `readonly-source-consumers-v1` 和 `readonly-source-consumers-v2`：[来源检查](../../../../extensions/aspera/docs/storage-governance.zh.md#agent-selected-environment-repair)核验子进程归属，保留原任务保护和稳定诊断。

`materialRecoveryVersion: 1` 要求 `managed-material-recovery-v1`。读取可选 `settlementError`。[恢复](../../../../extensions/aspera/docs/storage-governance.zh.md#fixed-materials)保留诊断和 stdout/stderr，确认退出后提交收尾，不下载。旧控制进程须经空闲维护。

`storagePreflightVersion: 2` 要求 `storage-preflight-v2`。[预核验](../../../../extensions/aspera/docs/storage-governance.zh.md#storage-preflight)分开核验、预算及已批准保留策略。`requirementLedgerVersion: 1` 要求 `storage-requirement-ledger-v1`：依赖试算不能修改已发布要求，材料遗漏继续阻塞。重新生成消费者。

`repairVersion: 1` 要求 `managed-environment-repair-v1`。Agent 选择[修复和引用确认](../../../../extensions/aspera/docs/storage-governance.zh.md#agent-selected-environment-repair)，历史 RECORD 文件保持不变。

`reusePrecheckVersion: 1` 要求 `historical-environment-precheck-v1`，用于[初步检查](../../../../extensions/aspera/docs/storage-governance.zh.md#historical-environments)。

`reuseVerificationVersion: 1` 要求 `storage-reuse-verification-v1`，用于[有预算限制的来源核验](../../../../extensions/aspera/docs/storage-governance.zh.md#automatic-history-reuse)。已登记的就绪清单先于旧线索。显式选择保留来源；字段提供 `value` 或 `page`。

协议 4、本机存储域 6、Session 及提交保持不变。`sandboxVersion: 1`/`sandboxIpcVersion: 1` 要求 `bounded-sandbox-launch-v1`/`short-temporary-paths-v1`；旧控制进程须在空闲后受控维护。

`managed-environment-install-v3` 要求匹配控制进程并固定 `pipVersion`。`create` 合并要求，`install` 替换要求。冲突阻止未修复的重复尝试。等待回执、退出和准入释放。读取有界 JSON／详情分页，`operationReconnectTimeoutMs` 默认 60000。`lockReceiptVersion: 1` 要求 `managed-environment-lock-receipt-v1`；旧控制进程需在空闲后升级以支持[包锁拒绝记录](../../../../extensions/aspera/packages/runtime/README.zh.md#model-experience)。

`managed-environment-reuse-v1` 要求[已验证材料、保留的解析结果和已确认退出](../../../../extensions/aspera/docs/managed-environments.zh.md)。

`canonicalDatasetVersion: 1` 要求 `canonical-modelscope-dataset-v1` 及 Host Git，模型要求 Hugging Face 清单。准备阶段检查诊断临时空间上限和 bubblewrap，安装保留模型预算。

## 迁移

尚未提交的工作使用原目录安排、观察和操作重试。[准备说明](../aspera-preparation/guide.zh.md)涵盖 SSH 输入流和沙箱终止证据。重新验收交接。

`registrationFormat: "0.1.3"` 要求 `storage-registration-0.1.3`、`bounded-diagnostics-0.1.3` 和 `command-admission-0.1.3`。配置 `finalization.diagnostics`，bubblewrap 必须支持 `--size`。[私有构建](../../../../extensions/aspera/packages/dispatch/README.zh.md#sandbox-compatibility-repair)使用 `sandboxNativeBuildTimeoutMs`／`sandboxNativeBuildBytes`。原生程序索引及尝试使用独立版本 1 记录。启动未确认时保留截止时间和固定发布。

`materialFormat: "0.1.2"` 要求 `material-source-bindings-0.1.2`。预算通过 `materialSources` 绑定核验回执，发布记录保留来源。旧回执不能证明其他目录。重新生成 Remote 类型及消费者。

`materialFormat: "0.1.1"` 要求 `targeted-materials-0.1.1`。更新资源保留受阻结果，不恢复训练或替换活动控制进程。

核验无需全量扫描或下载预算，取得材料需要容量准入。预算不包含未声明材料。[结束判定](../../../../extensions/aspera/docs/finalization.zh.md#finish-decisions)要求节点操作证据，缺少支持的 Agent 解释保持未核验。

`storageFormat: "0.1.0"` 要求 `purpose-storage-0.1.0`；[存储治理](../../../../extensions/aspera/docs/storage-governance.zh.md#records-and-compatibility)定义兼容方式。

`storageVersion: 1` 要求 `storage-governance-v1`、`historical-environment-borrow-v1` 和 `managed-materials-v1`。配置 `managedEnvironments.governance`，更新计划／刷新消费者。传输默认两小时、每服务器一个。

`managed-environment-cleanup-v1` 要求按真实挂载身份清理。隐藏的待清理残留保留引用，安全错误与未知退出继续阻塞。恢复保留失败回执，并要求重新核验。

1. 更新桌面 Host/runtime/Web。保留可执行文件和发布，复制旧实验前先释放资源。
2. 配置 `managedEnvironments` 及固定 uv/pip，`DSH_CLUSTER_ENVIRONMENT_POLICY_JSON` 传递策略。旧发布缺少 pip 设置，v3 需要空闲修复。
3. Agent 选择 `training` 依赖／导入、恢复并复验。修改前停止使用者，复用匹配包。
4. 使用[空间预览／清理](../../../../extensions/aspera/docs/managed-environments.zh.md#space-and-cleanup)。确认远端删除后再释放引用；引用未知、进程活动或预览摘要变化时禁止回收。
5. 验证 profile 和 Linux，单独记录 CUDA。
