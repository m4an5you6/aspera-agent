---
kind: upgrade-guide
description: "Aspera 文档工具结果改为分页记录，计划支持结构化输入与持久草稿修正。"
---

# Aspera 计划工具

[English](guide.md) | 中文

## 变更

计划接受可选的 `workload: training|inference`。推理禁止填写训练阶段，省略时保留训练检查。草稿工具可写入、读取和删除该字段。`asperaPlanningTools.inferenceVersion: 1` 要求 `inference-plan-v1`；已有批准计划保持原样。参见[计划兼容说明](../../../../extensions/aspera/docs/planning.zh.md#persistence-and-compatibility)。

`asperaPlanningTools.requirementsVersion: 1` 要求 `planning-requirements-v1`。可选的已声明输入名 `aspera-plan-requirements.json` 专用于版本 1 用户要求：`stepCount`、`stages` 和 `storagePolicy`，上限 64 KiB。SHA-256 与文件身份确认其来源。草稿提交、批准和执行均拒绝更改目标、调度器、证据或保留策略；Agent 通过现有工具修正草稿。可读取草稿 `requirements` 章节。独立 `planning-v1/requirements.v1.json` 在重新打开时拒绝省略或改变来源。已有输入声明、计划、协议与 Session 保持原格式，旧固定发布不实现此输入名的新含义。

新固定发布声明 `planning-drafts-0.1.0` 和 `documentation-pages-0.1.0`。`read_framework_documentation` 返回含有界原文、快照身份、续读入口和明确失败状态的 JSON 记录，不再返回完整原始网页。默认网络读取总时限为 30 秒。已保存失败需要显式重试；现有命令和安装时限不受影响。

`read_experiment_input` 现在默认返回分页 UTF-8 `text`，以 `chunkBytes` 与 `documentationPageBytes` 的较小值为上限。按文件字节位置 `nextOffset` 与 `generation` 续读，遇到 `reset` 时重新合并；JSON 片段合并后才能解析。二进制调用者必须指定 `encoding: base64` 才能取得 `data`。原输入字节、摘要和提交格式保持不变，旧固定发布仍默认返回 Base64。

`save_experiment_plan` 接受结构化 `plan`、兼容 `plan_json` 或 `draft_revision`。可解析但被拒绝的提交保留为可修正草稿。新增定义、草稿读取与编辑、校验工具，提供准确类型与局部修正。最终审批要求保留。私有规划记录采用独立的第 1 代、业务格式 `0.1.0`；本机记录、控制协议与 Session 格式不变。

草稿 `steps` 也接受最终计划定义中的文本条目，从第 1 步起逐项写入。原 `{step,text}` 带序号补丁继续受支持，两种格式不能混用。较短列表保留尾部步骤，删除仍须显式指定。`get_experiment_plan_schema(section: "stepEdits")` 展示草稿输入。步骤持久格式、批准规则和请求身份检查保持不变，原固定发布继续使用原输入定义。

## 迁移

1. 使用现有资源更新器同时更新 Host 和 runtime 资源，保留原 EXE 与资源备份。在 `aspera-dispatch` 中按需配置 `documentationReadTimeoutMs` 和 `documentationPageBytes`；默认值为 30,000 和 8,192。
2. 更新文档结果消费者，检查 `state`、使用 `text` 并跟随 `next`；仅在明确需要新尝试时使用 `retry: true` 或 `refresh: true`。不要将未完成读取当作完整文档。
3. 使用新固定发布的新建或复制实验。已有实验保留原发布、工具、参数及后续阶段；更新不会重跑实验或自动升级其远端控制服务。
4. 通过 `get_experiment_plan_schema` 确认计划的嵌套枚举与布尔字段。使用 `update_experiment_plan_draft` 修正被拒绝字段，再提交草稿版本。持久身份、并发与分页规则见[计划工具](../../../../extensions/aspera/docs/planning.zh.md)。
