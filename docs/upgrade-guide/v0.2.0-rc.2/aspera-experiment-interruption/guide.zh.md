---
kind: upgrade-guide
description: "Aspera 增加持久实验中断 API，并在控制进程恢复前收尾已经确认退出的旧任务。"
---

# Aspera 实验中断

[English](guide.md) | 中文

## 变更

`interruptExperiment(id)` 返回 Host 后台停止操作的受理结果；`experimentInterruptionStatus(id)` 只读查询操作。fleet 快照要求 `interruptions`。原 `cancelExperiment` 返回类型不变，等待同一资源核验完成。生成的 Remote 使用方需与应用资源一并更新。文件、日志、轨迹、原计划与硬件要求继续保留。

用户停止沿用底层 `cancelled`，确认释放后显示为已中断。准备的 `repair_preparation_controller` 可在控制进程退出后收尾已启动旧任务，前提是全部原 Agent、命令、服务与节点均确认结束。可信终态结果保持不变，否则记录为 `interrupted`。排队和等待计划确认任务要求用户主动操作。准备流程不停止活动任务或探测未选节点。

独立版本 1 中断与 Linux 进程身份文件保存操作、原提交、节点证据和恢复状态。本地 fleet 第 6 代、提交协议 4 与 Session 格式保持不变。退出未知时保留分配。[受控中断](../../../../extensions/aspera/docs/state-and-api.zh.md#experiment-interruption)说明文件位置、PID／启动身份核对、传输恢复与清理。

## 迁移

1. 同步更新资源与 Remote 描述。使用 `experimentInterruptionStatus` 或快照读取进度；受理不代表停止已完成。原 EXE 支持对应桌面资源更新。
2. 已启动任务使用中断实验，待开始任务使用取消实验。受阻操作展示退出核验及重试。切换页面和隐藏窗口保留操作；程序重启先读取保留证据，再决定后续停止操作。
3. 接管资源或删除前核验全部原节点。Linux SSH 停止要求持久身份与 pidfd 支持。旧版本缺少证据时，使用原认证释放接口或由操作者确认退出，不能修改记录强行释放。
4. 旧任务释放后在原 Session 重试准备。准备 Agent 调用 `repair_preparation_controller`，读取回执并请求 `verify_preparation_environment`。完整隔离、工作目录、凭据隐藏、GPU、授权及网络核验仍然必需。连接检查继续只读并限时 20 秒。
5. 已删除实验通过服务器卡片使用同一收尾服务。按[远端任务恢复](../aspera-remote-task-recovery/guide.zh.md)更新独立归属记录和生成的 Remote 使用方；不要恢复已删除列表项或手动清除远端分配。
