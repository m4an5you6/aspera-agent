---
kind: upgrade-guide
description: "Aspera 自动配置所选 SSH 账号的环境，并写入第 5 代本机派发存储。"
---

# Aspera 环境准备

[English](guide.md) | 中文

## 变更

本机准备 Agent 可使用所选 SSH 账号已有权限，安装和配置 Node、固定版本 pnpm、Python 3、bubblewrap 及所需用户态依赖。派发配置移除 `allowedSystemPackages`；`preparationOutputChars` 限制每条命令提供给模型的 stdout 和 stderr。远端交接仍以沙箱和 GPU 验收通过为前提。

本机派发存储写入第 5 代并读取第 1–4 代。远端提交仍使用协议 4。服务器探测可以报告账号已连通但环境尚未就绪，此时 `inventory` 字段可缺失。配套的生成 Remote 消费者必须处理该结果。

## 迁移

1. 实验仍在使用时，保留现有应用和远端发布目录。从自定义 `@aspera/dispatch` 配置中移除 `allowedSystemPackages`，部署配套的应用、生成 Remote 和依赖锁文件。
2. 使用已有权限覆盖预期环境准备操作的 SSH 账号。在准备记录中检查执行的命令、诊断及验收结果。宿主内核或 GPU 设备限制需要执行报告中的平台操作。
3. 重试失败的第 4 代准备，以保留实验、Session、模型和目录。原远端发布必须保留匹配的清单及必要入口。应用和 DSH 清单都缺少 `engines` 的已知发布使用其已记录版本要求。发布不可用或要求未知时复制实验；重试不会换用当前构建。
4. 对结果未决的准备命令，先检查远端执行情况再重试。已保存的远端退出记录允许继续验收，无需重复该命令。
5. 在实验详情中确认环境验收及远端交接。参见[派发参考](../../../../extensions/aspera/packages/dispatch/README.zh.md)。
