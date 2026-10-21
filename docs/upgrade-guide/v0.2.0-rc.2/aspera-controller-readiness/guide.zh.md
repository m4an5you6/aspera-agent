---
kind: upgrade-guide
description: "Aspera 在复用前核对 GPU 身份和控制进程授权，并支持准备 Agent 发起空闲控制进程修复。"
---

# Aspera 控制进程就绪检查

[English](guide.md) | 中文

## 变更

准备流程比较实际 GPU UUID、字符设备与控制进程启动时的授权。控制接口健康不代表环境兼容。所选准备 Agent 接收具体差异，可以调用 `repair_preparation_controller`；交接前仍须通过程序复验。新节点控制进程在分配实验时再次核对 GPU 身份。

经过认证的健康响应声明 `controller-readiness-v1` 和 `controller-maintenance-v1` 能力。维护操作原子拒绝被占用的控制进程，并在按身份停止进程前阻止新任务接入。已退出的控制进程使用 SSH 释放证据和对应角色维护恢复；控制端口关闭不要求修改云平台策略。控制进程在原运行目录中使用按发布隔离的 profile，保留旧绑定、任务及 Session。`controllerRepairMaxAttempts` 默认为每个实验、服务器、角色两次。独立版本 2 修复回执保留版本 1 历史、上限及结果未决状态；重复或恢复操作不重置次数。本地 fleet 存储仍为第 6 代，提交仍为协议 4，Session 格式不变。

密码 SSH 在认证前发生临时故障时，可在一次截止时间内重连。已有准备使用当前[握手限制](../../../../extensions/aspera/packages/dispatch/README.zh.md#use-this-package)，保留原安装和发布记录。认证、主机密钥及认证后操作失败均不触发重复执行。连接检查仍限时 20 秒。

准备验收执行沙箱的完整隔离，包括移除全部能力。在 `--unshare-user` 后拒绝挂载 `/proc` 时，提供兼容方案的实测诊断。方案可用时，准备 Agent 调用 `repair_preparation_sandbox` 安装不可变的私有 PID/proc 启动器，再请求程序复验。程序路径字段保存其位置；版本 1 描述文件及回执保留身份与恢复证据。宿主策略保持不变。[沙箱兼容修复](../../../../extensions/aspera/packages/dispatch/README.zh.md#sandbox-compatibility-repair)说明限制、未决结果及与控制进程共存的要求。

恢复流程在启动前核对旧任务，只收尾确认已经退出的工作。[受控中断迁移](../aspera-experiment-interruption/guide.zh.md)说明任务结果、节点范围、待开始任务及 Remote 使用方。

## 迁移

1. 同步更新资源、生成类型和自定义 `FleetDriver` 消费者；提供方实现 `inspectController`。现有执行文件支持匹配的资源更新。配置[本机运行记录](../../../../extensions/aspera/docs/state-and-api.zh.md#local-running-records)，不改写实验。
2. 保留原发布和提交。旧进程探测读取限定、无凭据的启动设置。复用要求启动 GPU 身份、当前设备及发布均匹配。缺少安全维护时，须确认释放并由操作者停止；准备流程保留封存发布。
3. 重试前核对中断的修复。确认停止的回执或身份匹配的新进程允许恢复；缺少退出证据时阻止再次停止或启动。修复次数跨重试保留。
4. 控制端口离线或 profile 绑定旧发布时，在原 Session 重试准备。先调用 `repair_preparation_controller`，再调用 `verify_preparation_environment`，保留旧 profile 和回执。释放未确认时仍然阻塞。已提交实验的 GPU 要求变化时需要复制；计划、提交和执行保持固定。见[控制进程就绪与恢复](../../../../extensions/aspera/docs/state-and-api.zh.md#controller-readiness)。
5. 在原 Session 重试失败的准备，获取沙箱诊断与修复。保留全部隔离参数并完整复验启动器。兼容的私有 PID/proc 父环境不可用时，请求具体云平台权限。更新已提交实验的执行资源前，确认资源释放并复制实验。
