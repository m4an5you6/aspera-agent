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

`extensionRoot` 选择固定发布，`dataRoots` 允许读取本地输入文件，`agentCredentialRefs` 指定私有模型凭据。`minimumFreeBytes` 配置保留空间，默认 1 GiB，并随实验固定。操作、轮询和下载设置由 [Config](src/index.ts) 校验；随包配置读取 `ASPERA_DATA_ROOTS` 和 `ASPERA_MODEL_CREDENTIAL_REFS`。检查连接不调用模型或创建远端目录。

服务器使用密码登录和独立用户名。首次保存的服务器固定担任调度主机，在其管理状态期间不能修改地址、控制端口或根目录。拒绝相同的 SSH 地址及端口。普通服务器编辑不会修改已固定的实验。节点使用配置的控制端口，调度服务使用下一端口。

`AsperaRemote` 提供类型化普通方法及可重连的快照流，`ExperimentFleet` 管理工具和 Web 相同的派发行为，`FleetDriver` 提供完整部署能力。输入写入有界且幂等，下载使用一次性票据，卸载会等待本地工作结束而不取消远端已接管的任务。

-----

<a id="understand-the-implementation"></a>
## 了解实现

模型提交通过 DSH 提供商目录解析三个显式选择。[models.ts](src/models.ts) 保存私有 API 设置和独立凭据引用，重试读取这些快照。DeepSeek 及支持的 pi-ai 密钥接口使用固定适配器。保留历史 `agentCredentialRefs` 配置的读取；第 4 代仅移交已接收阶段快照引用的凭据。

<details>
<summary>实现细节</summary>

[fleet.ts](src/fleet.ts) 管理登记、准备、Goal 校验和完整回执。[storage-selection.ts](src/storage-selection.ts) 仅提供探测及候选选择工具；[network-selection.ts](src/network-selection.ts) 检查互通并等待清理。[snapshot.ts](src/snapshot.ts) 打包固定发布，[cluster-deploy.ts](src/cluster-deploy.ts) 保留活动控制进程和私有凭据。[downloads.ts](src/downloads.ts) 中止断开的读取。归属关系由准备和运行时操作检查，不发布仅验证服务存在性的 invariant。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [启动工程](../../README.zh.md)
- [执行角色](../runtime/README.zh.md)
- [状态与接口归属](../../docs/state-and-api.zh.md)

<a id="model-experience"></a>
## 模型体验

派发工具列出不含凭据的服务器、提交明确的服务器组并读取实验状态。要求和完整接收回执保存在派发 Session 中。固定首行**本机派发完成，远端实验已接管**仅在本地持久保存回执后出现，ID 和版本比较防止完成已编辑的 Goal。框架执行由远端运行时负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 公开服务器配置只支持密码，不提供密码和密钥的优先选择。
- 主机密钥必须预先在 `known_hosts` 中被信任，未知或变化的密钥导致失败。
- 保留第 1～3 代记录及原摘要；旧版未完成准备通过复制为新实验继续。
- 不兼容的控制升级需等待原任务及控制服务结束。

### 开发备注

无。
