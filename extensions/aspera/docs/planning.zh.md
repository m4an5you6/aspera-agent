---
kind: reference
description: "通过有界文档读取与可局部修改的持久草稿编写固定版本计划。"
---

# 计划工具

[English](planning.md) | 中文

## 摘要

Agent 决定文档、调查顺序与计划内容。Aspera 保存文档和草稿、校验字段，并在审批前提交完整计划。这些工具属于声明 `planning-drafts-0.1.0` 和 `documentation-pages-0.1.0` 的固定发布；已有实验保留原发布与工具。

## 目录

- [文档](#documentation)
- [草稿与提交](#drafts-and-submission)
- [持久化与兼容](#persistence-and-compatibility)

<a id="documentation"></a>
## 文档

`read_framework_documentation` 接受允许列表中的 HTTPS `url`。`documentationReadTimeoutMs` 默认 30,000 毫秒，同时约束连接、响应头和整个正文，不使用安装或命令时限。`documentationPageBytes` 默认 8,192 字节 UTF-8 正文。这两个设置可在 `aspera-dispatch` profile 配置和 worker 配置中调整。现有 `documentationBytes` 下载限制和主机列表继续生效。新部署将限制保存到私有实验快照，复用常驻调度进程时也保留本实验的限制；文档存储在首次读取时保存该限制。修改配置不会重置该 Session 已保存的限制。

成功响应返回原始 `text`、`snapshotId`、`sha256`、`readAt`、`cached` 和可选的 `next` 请求。使用 `next` 续读同一不可变快照；`query` 定位字面文本。游标使用 UTF-16 字符偏移，分页限制按 UTF-8 字节计算。搜索未命中返回 `queryFound: false`。不同 URL 保留各自来源身份。工具不生成文档摘要，也不调用另一个模型。

`read_experiment_input` 默认返回已提交的 UTF-8 文本。分页使用 `chunkBytes` 与 `documentationPageBytes` 中的较小值，返回文件字节位置 `offset`、`nextOffset`、`generation`、`reset` 和 `eof`。从返回的字节偏移续读；未完整的多字节字符保留到下一页。大型 JSON 的各页是文本片段，合并后才能解析。文件代次变化时，从字节零重新读取。显式 `encoding: base64` 保留二进制访问。工具核对不可变的提交文件名，无需 Shell 或解码临时文件。

`refresh: true` 请求新快照，同时保留旧快照。`retry: true` 在失败后明确启动下一次尝试。普通读取复用完整快照或原失败回执。并发读取共享进行中的请求，不延长截止时间。失败返回 `state: failed`、`complete: false`、URL、请求身份、耗时、已接收字节，以及超时、取消、HTTP、大小、网络或中断类别。部分正文保留为私有未完成记录，不能成为完整文档快照。工具拒绝重定向、URL 中的凭据及配置列表之外的主机。

<a id="drafts-and-submission"></a>
## 草稿与提交

`workload` 区分 `training` 与 `inference`；框架名称本身不能证明任务需要新训练。纯推理计划声明 `workload: "inference"` 并省略训练阶段。保留断点通过推理断点工具核验，不填写占位训练阶段或调度器数值。缺少 `workload` 时保留原训练检查。已声明的训练要求继续强制执行，不能通过选择推理将其删除。

`get_experiment_plan_schema` 返回权威输入定义和有效示例。`steps` 展示已保存的文本步骤，`stepEdits` 展示草稿输入，也可选择 `samples`、`scheduler` 与 `results` 等章节，必要时使用续读入口。`samples.unit` 接受 `example` 或 `microbatch`，`samples.meaning` 接受 `consumed` 或 `fetched`，解释文字放入 `basis`，`results.baseControl` 是布尔值。工具字段声明与最终验收来自同一套 Zod 定义；跨字段算术与引用由服务端校验。

`update_experiment_plan_draft` 接受 `requestId`、`expectedRevision` 和可选章节。新草稿使用版本零。`steps` 可以是从第 1 步起逐项写入的文本列表，也可以是使用原始一起始编号的 `{step,text}` 补丁，同一请求不能混用两种格式。较短文本列表保留未涉及的尾部步骤。阶段按 `stageId` 合并，包括局部 `samples`、`scheduler` 与 `results`。未提供的字段保留。`removeSteps`、`removeStages`、`removeFields` 和 `removeStageFields` 显式删除内容，不重排引用编号。草稿可以尚未完整。工具返回已保存版本与可处理的问题，不重复返回全文。

`read_experiment_plan_draft` 默认返回摘要，也可返回指定章节与续读入口。`issues` 章节在摘要受限时提供完整校验问题。章节分页明确标记为 JSON 文本片段，并绑定一个草稿版本；版本改变返回冲突。`validate_experiment_plan_draft` 检查最新内容，不批准或执行计划。仅对相同修改复用请求身份；过期预期版本返回当前版本，不覆盖它。

`save_experiment_plan` 在 `status: completed` 时，恰好接受结构化 `plan`、兼容 `plan_json` 或 `draft_revision` 中的一项。可解析但被拒绝的完整提交保留为草稿。只修正报告的字段，再提交新版本；无效 JSON 返回语法错误，不替换草稿。最终提交检查完整计划、阶段算术、调度器时域、步骤引用及身份唯一性，原子写入现有计划回执后才完成规划 Goal。已保存草稿冻结。全自动和半自动审批仍是现有的独立操作；草稿编辑不能改变已批准计划。`status: blocked` 保留现有的前置条件受阻结果。

可选的已声明输入 `aspera-plan-requirements.json` 在规划前固定用户已确认的要求。其版本 1 JSON 包含 `stepCount`、完整 `stages` 和 `storagePolicy`，上限为 64 KiB。程序核对提交的 SHA-256 和普通文件身份，再比较阶段 ID／引用、步数目标、调度器、样本约束、证据文件集合、结果及保留策略。要求中省略 `samples` 时，禁止添加猜测数值。叙述标题和估算说明仍由模型编写。调用 `read_experiment_plan_draft(section: "requirements")` 读取，修正报告字段后重新提交同一草稿；模型修改不能改变要求。批准和执行入口独立复核。未声明的输入保留现有行为。

持久类型变更确认：`planning-v1/requirements.v1.json` 是原规划归属下的独立版本 1 来源记录。重新打开时拒绝改变或省略要求。发布清单 `asperaPlanningTools.requirementsVersion: 1` 要求 `planning-requirements-v1`，不兼容控制进程须经受控维护。原草稿、计划、提交和 Session 格式保持不变。

<a id="persistence-and-compatibility"></a>
## 持久化与兼容

私有 `planning-v1` 记录采用 `version: 1` 和 `formatVersion: "0.1.0"`，将草稿、不可变版本历史与幂等请求回执绑定到实验、规划 Session 和固定发布。`documentation-v1` 保存独立的每 Session 归属、已固定限制、尝试、来源索引及不可变快照。重新打开只读取原记录，不自动恢复模型或实验。截止时间采用已保存的绝对时间。中断请求需要显式发起新重试。草稿修改和最终提交共用现有原子文件写锁；只有原写入进程已经退出，才允许恢复锁。

类型变更确认：`planDraftEditSchema.steps` 也接受文本条目。解析后的草稿和最终计划仍保存字符串数组，原带序号补丁继续有效。请求身份仍区分原始提交形式。持久记录、批准要求、协议与 Session 格式保持不变。

持久类型变更确认：可选的 `plan.workload` 由现有计划和草稿写入器保存；历史记录中缺少的值仍保持缺少。已有批准计划不会被改写。`asperaPlanningTools.inferenceVersion: 1` 在复用控制进程前要求 `inference-plan-v1`。本机第 6 代记录、远端第 4 代控制协议和 Session 事件格式保留原定义。模型可见内容和修改通过普通 DSH 工具调用记录。桌面资源更新不会给旧发布增加这些工具；应在正常能力检查后使用新发布的新建或复制实验。已有实验及后续阶段保留原材料、Session 与发布。

## 开发者说明

无。
