---
kind: upgrade-guide
description: "Aspera 要求指定实验调度主机，写入第 6 代本机记录，并提供显式管理操作。"
---

# Aspera 实验与服务器管理

[English](guide.md) | 中文

## 变更

Aspera `0.1.1` 要求 DSH `0.2.0-rc.2`。创建及派发要求从选中节点指定 `coordinatorId`、`coordinator_id`。同一 profile 内，不同调度主机不能使用重叠的未结束节点；同调度主机继续排队。首次确认不分配 GPU。

`aspera_fleet` 写入第 `6` 代、读取第 `1`～`5` 代。远端协议、存储及 Session 格式不变，旧任务保留调度主机、目录、凭据和摘要。节点命令键是按实验隔离的安全文件名，公开 ID 不变。持久化详情见[状态与接口](../../../../extensions/aspera/docs/state-and-api.zh.md)。

`probeServer` 返回结构化检查及带时间的硬件信息，只有 `revealServerPassword` 返回密码。删除接受 `allowUnconfirmed`，服务器删除接受 `allowLinked`。独立的 `aspera_removals` 第 `1` 代隐藏已删除对象，保留未确认归属。远端清理要求释放及目录证据，不设回收站。

`connectionCheckTimeoutMs` 默认 20000 毫秒。到期后取消探测、关闭连接并保存失败，与历史硬件信息及准备超时分别处理。

两种模式均使用发布版 DSH 的只读轨迹补丁，决策留在概览。版本化观测接口提供事件、附件、日志及实测指标。调度主机通过带认证的回环地址访问自身，其他节点使用 SSH。Toast 持久去重，保留失败和清理状态。

受管安装使用独立的 `aspera_preparation` 及远端安装记录第 `1` 代。固定的默认限制为总计 30 分钟、连续 5 分钟无进展、最多额外尝试两次。准备 Agent 可切换经探测的 HTTPS 来源，仍须通过程序验收。升级不会重跑失败实验，原始材料缺失或无法核验时阻止恢复。

## 迁移

1. 安装匹配的 Host／客户端构建，重新生成 Remote。指定所选调度主机，注册顺序不分配角色。
2. 保留 fleet、远端及删除记录，不降级到不兼容的读取版本。重新添加服务器需使用新 ID。
3. 检查消费者读取 `status`、`checkedAt`、`configuration`、`result`、`lastSuccess`，区分失败检查与历史硬件信息。
4. 读取 `recordDeletionAvailable`、`removedServerIds`、`unconfirmedWork`。确认未核验任务的本机删除，更换清理策略需新操作 ID。复用节点前核验保留的任务，服务器删除保留关联实验。
5. 在 `ExperimentFleet.open` 的第三个参数传入 `connectionCheckTimeoutMs`，其后传入驱动。准备保留 `toolTimeoutMs`。驱动须响应取消并遵守专属清理要求，遵循[验证流程](../../../../extensions/aspera/docs/verification.zh.md)。
6. 安装匹配的 UI 补丁，在截断前采集完整输出。保留运行版本，控制升级要求任务完成及清理确认。保留桌面 EXE。
7. 在 `aspera-dispatch` 配置安装限制，自定义 fleet 调用者在第五个参数传入。读取快照 `installations` 及重试 `{ record, installations }`。保留记录、归档、缓存及远端记录。显式重试建立新预算并保留历史，退出未确认的安装进程在取消／删除后仍保留归属。更新现有运行资源。
8. 读取 `experimentExecutionProgress` 并保留独立的 `execution-progress.v1.json` 文件。新执行 worker 完成前必须上报批准步骤，仍须独立验收。旧固定发布展示未记录的步骤，不升级已有任务；确认资源释放后复制实验，并处理 Goal 与实际硬件不一致的问题。
