# 阶段验收与实验收尾

[English](finalization.md) | 中文

<a id="summary"></a>
## 摘要

现有 DSH 执行 Agent 选择批准要求及证据，Aspera 执行命令等待、数值检查和结束判定。不增加编排 Agent，不修改 Agent 主循环。历史复验只读取已有文件，不能重新训练、评估或生成推理结果。

<a id="table-of-contents"></a>
## 目录

- [批准的阶段](#approved-stages)
- [命令等待](#command-waiting)
- [结束判定](#finish-decisions)
- [历史复验](#historical-review)
- [记录与兼容](#records-and-compatibility)

<a id="approved-stages"></a>
## 批准的阶段

计划可以包含结构化 `stages`。Transformers/ms-swift/PEFT 计划在批准前必须提供阶段。每个阶段绑定计划步骤、累计起止步数、新增优化器步数、指标范围与记录频率、scheduler 恢复方式／总长度／warmup、明确的样本计数依据及可选结果要求。允许区间内的取值在批准前固定。`30 + 200 = 230` 表示新增 200 步并结束于累计 230 步，不要求新增 230 条指标。稀疏日志按声明的优化器步检查，相同重复记录去重，冲突尝试被拒绝。

`register_experiment_stage` 在启动前将批准要求绑定到节点、尝试、命令及工作区相对路径中的生效参数、trainer state 和结果。程序独立读取、计算参数摘要，并在启动绑定命令前再次检查。`verify_experiment_stage` 核验原命令成功退出与释放、checkpoint 起止、生效参数、指标覆盖、scheduler 及实际样本记录。继续原 scheduler 时沿用原 warmup 和总长度；重启调度必须使用批准的 restart 模式。缺失、截断或不支持的来源保持未核验。Shell 退出 0 和 Agent checklist 不能替代程序检查。

结构化评估和重载证据必须提供实际样本数、有限 loss 和非空回答，并标识登记的训练 checkpoint。续训还要求独立计算原 optimizer、scheduler 及 RNG 文件摘要、核对非仅权重恢复的生效配置、checkpoint 起止、学习率数值连续性和样本顺序证据。不执行二进制 checkpoint 代码。声明产物路径必须对应有归属且非空的文件。解析器支持有读取上限的 Transformers trainer state、JSON 和 JSONL 证据；不支持的格式返回明确诊断，不能推断通过。

<a id="command-waiting"></a>
## 命令等待

`run_experiment_command` 等待原命令真实终态及清理确认。等待期间保持 DSH 工具独占属性，周期性的轻量状态读取不会触发下一次模型请求。日志归档和页面刷新独立运行。空读取或文件 EOF 只表示当前没有更多字节。

`run_experiment_command_group` 先提交全部授权成员再等待，支持分布式 rendezvous。经过认证的启动拒绝只停止内容匹配、已启动的成员，并核验退出。传输回复丢失时核对原成员，不启动替代命令。同一操作 ID 保留原请求。常驻推理继续使用专用服务工具。

`finalization` 配置默认为每秒轮询、单次读取 30 秒、连续连接恢复预算 60 秒，以及两次无证据理由纠正。已有明确命令期限继续生效；这些设置不增加训练总时限。取消观察不能证明远端退出，未决退出继续保留资源保护。等待不持有服务器全局锁。

<a id="finish-decisions"></a>
## 结束判定

完成检查、finish 请求和最终收尾共用逐节点执行、步骤、环境、命令及阶段检查。收尾命令仍运行时继续等待。缺少记录时返回具体补录方法，Goal 保持活动。有证据的实际要求失败可以受阻结束，不伪装全部步骤已完成。提交结果前重新核对来源身份与命令事实。

预算理由区分实际输入超限错误、单次输出 `max-tokens`、程序配置预算、压缩失败和 Agent 自述。只有匹配的实际 Session 事件能确认预算故障。token 总量与模型声明窗口不能单独证明耗尽。无证据声明得到有限次数纠正；仍无法收尾时记录为 Agent 收尾未完成，保留原证据及未决占用。

<a id="historical-review"></a>
## 历史复验

[完成证据复验](completion-review.zh.md) 保留原结果。已释放的 blocked 实验还必须具备明确的原结构化要求或程序识别的显式旧续训要求、原 blocked finish／Goal 变更、达到批准终点的 checkpoint、非空 adapter，以及全部节点原命令退出与释放证据。具备资格不代表通过。

受限补录 Agent 使用原模型和独立 Session，可以登记历史阶段、请求数值核验，以及按当前 assessment 版本提交引用实际来源的步骤补录。原步骤记录不修改。不适用报告必须对应原计划明确声明且程序确认未触发的条件步骤。发布独立、带时间的通过回执前，必须重新通过文件、环境、结果及释放检查。原文件不可达时继续待验，即使本机轨迹可读。

<a id="records-and-compatibility"></a>
## 记录与兼容

持久类型变更确认：[阶段定义](../packages/experiments/src/stage-requirements.ts) 为计划增加可选结构化阶段与条件步骤，旧计划继续可读。[收尾类型](../packages/experiments/src/finalization.ts) 定义独立版本 1：原私有运行目录中的 `stage-acceptance-v1` 登记／验收、`command-waits-v1` 命令等待、`command-groups-v1` 固定组请求和 `finish-decision.v1.json`。复验新增记录位于本机原回执旁的 `<experimentId>.assessment-v1.json`，以及远端 `completion-assessments-v1/<operationId>.json`。原结果、执行条目及步骤文件保留。

`experimentCompletionAssessment(id)` 读取独立历史核验。`experimentFinalizationStatus(id)` 通过协议 4 认证接口或程序拥有的只读 SSH 后备读取轻量私有记录，在 `$DSH_HOME/aspera-run-records/<experimentId>/finalization.v1.json` 保留远端错误和原观察时间。删除及退出先停止并等待读取，再清理副本；迟到回复不能恢复记录。终态实验和离线观察停止动画。本机存储域 6、提交协议 4 及 Session 格式不变，全部生成 Remote 消费者同步更新。

新发布声明 `asperaFinalizationVersion: 2`，准备及控制进程复用要求 `experiment-finalization-v2`。旧实验继续使用固定发布，Host 历史复验不升级原发布。实验专属清理包含新增私有记录。参见[升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-finalization/guide.zh.md)。
