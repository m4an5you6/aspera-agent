---
kind: upgrade-guide
description: "Aspera 的 DeepSeek 阶段快照使用可复用的插件输入，恢复时保留早期已解析快照。"
---

# Aspera DeepSeek 模型快照

[English](guide.md) | 中文

## 变更

DeepSeek 阶段准备可能在创建 Agent 前报错 `retryPolicy: unknown key "initialDelayMs"`。提交时保存的是提供商的已解析设置，阶段启动却将其作为插件配置传入。已解析重试延迟使用平铺字段；插件输入要求放在 `retryPolicy.backoff` 中。已解析思考与文件策略也使用不同字段名。

提交现在保存带显式默认值的可复用插件输入。启动先校验原回执哈希，再在内存中转换早期已解析快照，保留配置内容、哈希、凭据引用、选定模型和 Session。混用格式或无效设置仍会报错。私有快照版本 `1`、本机存储域 `6`、提交协议 `4` 和 Session 格式保持不变。[状态与 API 文档](../../../../extensions/aspera/docs/state-and-api.zh.md#persistent-ownership) 说明兼容细节。

## 迁移

1. 更新桌面运行资源，完全退出并重新打开 Aspera。保留现有 EXE 和凭据存储。不要编辑已保存快照 JSON 或重新计算哈希。
2. 对尚未保存固定发布或远端交接就失败的实验重试准备。启动通过兼容转换读取其原快照。
3. 保留已经固定的远端发布。本机更新不会为既有封存发布增加兼容读取器。如果原发布无法启动其已保存模型，先确认旧任务释放，再复制实验到更新后的运行版本。
4. 在已具备桌面目录的 `extensions/aspera` 中运行 `pnpm run test:desktop:deepseek`。新建及已有 profile 均须通过原 EXE 与本机 Messages 测试接口完成标准 Agent 回放，以及使用新建和旧快照的准备、计划、执行回放。
