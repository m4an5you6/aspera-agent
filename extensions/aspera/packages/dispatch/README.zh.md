---
description: "通过共用的 DSH 工具、生成的 Remote 和固定发布版本配置服务器并派发固定 Aspera 实验。"
kind: "package-bundle"
---

# @aspera/dispatch

[English](README.md) | 中文

## 概要

提交多个独立 Goal、暂存输入，并在返回远端接管之前移交完整实验材料。重试期间保留服务器设置、凭据引用和发布身份。Aspera 页面与 Agent 工具共用任务服务，先保存完整回执，再完成身份匹配的派发 Goal。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

[工程启动](../../README.zh.md#start-the-management-page) 在已发布 DSH base/Web bundle 及本包 [cordis.patch.yml](cordis.patch.yml) 之上建立 `aspera` profile，装配接入层及管理页面。构建产物可以脱离 Harness 源码安装，[独立安装验证](../../scripts/test-installed.mjs) 检查同一 profile 和公开类型声明。

`extensionRoot` 选择固定发布，`dataRoots` 允许读取本地输入文件，阶段快照标识私有模型凭据。`minimumFreeBytes` 配置保留空间，默认 1 GiB；`preparationOutputChars` 限制每条命令向模型返回的 stdout 和 stderr，默认各 65536 字符。准备使用所选 SSH 账号的现有权限，不依赖系统包白名单。操作、轮询和下载设置由 [Config](src/index.ts) 校验；随包配置读取 `ASPERA_DATA_ROOTS` 并兼容旧 `ASPERA_MODEL_CREDENTIAL_REFS`。连接检查只读取远端状态，不调用模型或配置依赖，区分 SSH 可达与依赖未就绪，磁盘清单可能缺失。

`connectionCheckTimeoutMs` 为整轮连接检查设置统一截止时间，默认 20000 毫秒。主机密钥探测、环境检查、磁盘、GPU 和控制服务共用取消信号。到期后关闭活动 SSH 连接并保存失败状态，结束后才能再次检查；保留带时间的历史成功信息。准备与安装继续使用独立的 `toolTimeoutMs` 策略。自定义调用者在 `ExperimentFleet.open` 的可选驱动之前传入检查时限；驱动必须响应探测取消，并等待连接清理完成。

服务器使用密码登录和独立用户名。每个创建请求从 `serverIds` 中指定 `coordinatorId`，登记修改不影响提交快照。同一管理 profile 内，不同调度主机的未结束实验不能使用重叠节点。同调度主机继续按远端顺序排队，首次等待确认不分配 GPU。删除空闲服务器保留历史快照与远端文件，移除不再引用的自有凭据。待完成任务和清理未确认会阻止删除。节点使用配置的控制端口，调度服务使用下一端口。记录删除及兼容规则见[管理状态与清理](../../docs/state-and-api.zh.md)。

本机连接检查和准备会把首次遇到的主机密钥自动登记到所选 `known_hosts` 文件，默认 `~/.ssh/known_hosts`。探测不发送密码或执行远端命令，采用首次使用时信任，并使用跨进程文件锁登记。已有、已撤销或不受支持的身份不会被覆盖。后续密码登录核对已登记的密钥；远端委派连接要求预先安装的密钥。`FleetDriver` 提供方实现 `prepareSshHostKey` 及经过验证的 `cleanupServerStorage`；浏览器和 Host 通过 `@aspera/dispatch/server-usage` 共用移除检查。

重试从原发布读取环境要求。应用和 DSH 清单都缺少 `engines` 时，已记录的 Aspera `0.1.1` / DSH `0.2.0-rc.2` / pnpm `11.7.0` 组合要求 Node `^22.19.0 || >=24.0.0`。发布记录、依赖声明及已安装的 DSH 版本必须一致。未知组合或无效的已声明要求会停止准备；当前应用的 Node 范围不会替代原发布要求。

`AsperaRemote` 提供类型化普通方法及可重连的快照流，`ExperimentFleet` 管理工具和 Web 相同的派发行为，`FleetDriver` 提供完整部署能力。输入写入有界且幂等，下载使用一次性票据，卸载会等待本地工作结束而不取消远端已接管的任务。

-----

<a id="understand-the-implementation"></a>
## 了解实现

只读观测在返回完整事件、已登记日志、附件或实测采样前校验实验、节点和 Session 归属。准备命令先完整记录输出，再限制工具结果长度。提示指纹按管理 profile 持久保存；关闭 Toast 不清除失败或清理状态。[观测接口](../../docs/state-and-api.zh.md#logs-outputs-and-services) 定义游标和历史版本可用性。安装及发布移交通过 `@aspera/dispatch/compatibility` 校验固定版本的已发布 DSH 渲染适配。

模型提交通过 DSH 提供商目录解析三个显式选择。[models.ts](src/models.ts) 保存私有 API 设置和独立凭据引用，重试读取这些快照。DeepSeek 及支持的 pi-ai 密钥接口使用固定适配器。保留历史 `agentCredentialRefs` 配置的读取；第 4 代仅移交已接收阶段快照引用的凭据。

<details>
<summary>实现细节</summary>

[fleet.ts](src/fleet.ts) 管理登记、准备、Goal 校验和回执。[environment-preparation.ts](src/environment-preparation.ts) 为现有标准 DSH Agent 增加限定服务器的 SSH 探测、命令、验收及阻塞报告工具。[environment.ts](src/environment.ts) 在依赖 Node 的清单探测前，按发布要求检查程序。[storage-selection.ts](src/storage-selection.ts) 管理候选选择；[network-selection.ts](src/network-selection.ts) 检查互通并等待清理。[snapshot.ts](src/snapshot.ts) 打包发布；[cluster-deploy.ts](src/cluster-deploy.ts) 核对原发布并保留活动控制进程。同一服务器串行准备，执行命令前保存待确认记录。操作负责检查归属关系，不发布仅验证服务存在性的 invariant。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [启动工程](../../README.zh.md)
- [执行角色](../runtime/README.zh.md)
- [状态与接口归属](../../docs/state-and-api.zh.md)

<a id="model-experience"></a>
## 模型体验

派发工具列出不含凭据的服务器、提交明确的服务器组并读取实验状态。所选准备模型在同一 Session 中通过有日志的工具修复失败检查，SSH 凭据不进入模型输入。非零退出返回诊断，退出未确认则阻止重复修改。Agent 文字不能替代工作目录写入、隔离、凭据隐藏、GPU 和网络验收。已通过的检查进入 Agent 收件箱而不唤醒模型，由循环在首条系统消息之后纳入上下文。要求和回执使用现有 Session 事件；**本机派发完成，远端实验已接管**仅在保存回执后出现，ID 和版本比较防止完成已编辑的 Goal。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 公开服务器配置只支持密码，不提供密码和密钥的优先选择。
- 主机密钥必须预先在 `known_hosts` 中被信任，未知或变化的密钥导致失败。
- 保留第 1～3 代记录及原摘要；旧版未完成准备通过复制为新实验继续。
- 不兼容的控制升级需等待原任务及控制服务结束。

### 开发备注

无。
