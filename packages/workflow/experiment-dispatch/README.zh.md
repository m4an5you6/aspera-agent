---
description: "本机 DSH 工具：将源码快照部署到 GPU 工作端，并移交一项无人值守实验。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experiment-dispatch

[English](README.md) | 中文

## 概述

`experiment-dispatch` profile 与 Web Goal 流程会打包本机 DSH 源码，在配置好的 Linux GPU 服务器上构建独立版本，检查沙箱与 CUDA，然后向独立工作端提交一项实验。接管回执会保存接管说明、完成同一版本的本地 Goal，并记录远端 Session、Goal、产物与工作器日志。提交工具也会把接管说明写入本机会话。本机进程退出后，远端实验继续运行。

## 目录

- [使用](#use-this-package)
- [实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用

将 `DSH_EXPERIMENT_TARGET` 配置为已记录主机密钥的 SSH 主机，将 `DSH_EXPERIMENT_REMOTE_ROOT` 配置为绝对路径的私有目录，并通过 DSH 凭据服务提供 `DSH_EXPERIMENT_TOKEN`。可选项为 `DSH_EXPERIMENT_SSH_PORT`、`DSH_EXPERIMENT_PORT`、`DSH_EXPERIMENT_SSH_IDENTITY`、分号分隔的 `DSH_EXPERIMENT_DATA_ROOTS`、逗号分隔的系统包白名单 `DSH_EXPERIMENT_SYSTEM_PACKAGES`（默认 `bubblewrap`），以及 `DSH_EXPERIMENT_SETUP_TIMEOUT_MS`。可用的 bubblewrap 缺失时，安装流程将白名单内的软件包解压到私有工具目录。`DSH_EXPERIMENT_AGENT_CREDENTIAL_REFS` 指定逗号分隔的模型提供方凭据引用；默认为 `DEEPSEEK_API_KEY`，空值表示不传输。这些引用对应的值被复制到每个版本专用的私有凭据文件，不进入源码包或 Goal 文本。

SSH 登录方式二选一：设置 `DSH_EXPERIMENT_SSH_AUTH_MODE=password` 并填写 `DSH_EXPERIMENT_SSH_USERNAME`，或使用默认的 `key` 方式读取 OpenSSH 密钥。仍支持原有的 `user@host` 地址。密码方式在 Windows、macOS 和 Linux 上通过 SSH 密码认证执行命令、SFTP 上传和接收端请求，不会尝试已保存的密钥。Web 按服务器、端口和用户名分别保存密码，空格与特殊字符原样保留。无界面 profile 可用 `DSH_EXPERIMENT_SSH_PASSWORD_REF` 显式指定 `GPU_PASSWORD` 等凭据引用，并通过凭据服务提供其值。密码不进入部署设置、准备记录、工具参数或源码归档。

派发前，在运行 DSH 的机器上用 OpenSSH 核验服务器主机密钥。密码方式读取该用户的 `~/.ssh/known_hosts`，也可通过 `DSH_EXPERIMENT_KNOWN_HOSTS_FILE` 指定文件；支持哈希记录和非默认端口。主机密钥未知、变更或被撤销时，连接在密码认证前终止。密码方式要求可直接连接的服务器地址和 SSH 密码认证；SSH 别名、代理命令及交互式验证不会触发隐式回退。

`DSH_EXPERIMENT_SETUP_TIMEOUT_MS` 设置准备和提交工具的截止时间，以及源码归档、SSH 命令和 SCP 传输的进程超时；默认值为 1,800,000 毫秒。调大后，远端安装和构建可以运行更长时间。接收端每次 HTTP 请求仍有独立的 15 秒截止时间。

在仓库根目录运行 `pnpm dsh --profile experiment-dispatch "<实验目标>"`。本机 Agent 先调用 `prepare_experiment_environment`，再用返回的准备编号调用 `submit_experiment`。`get_experiment_status` 和 `cancel_experiment` 使用返回的提交编号。明确指定的模型、数据集、方法、GPU 数量和其他约束会传给远端 Goal。本机数据文件必须位于显式配置的数据根目录；未配置时不允许传输本机文件。接管前完成传输；其他数据引用必须已在远端工作目录中。

在 Web 中打开「插件 → GPU 实验派发」，选择「密码」，填写服务器地址、SSH 用户名、端口、服务器密码与远端目录。接收端令牌和模型凭据需要单独配置，服务器密码不能代替它们。保存后，在会话中输入 `/goal` 并写明实验要求。保存操作只配置目标，Goal 才会启动准备与派发。接管后，同一页面显示已保存的接管说明、回执与远端状态；「刷新」和「取消」始终使用提交时保存的服务器、账号与登录方式，即使当前配置已切换。若提交期间修改了本地 Goal，旧回执不会结束修改后的 Goal。

取消本机提交会停止自动重试，并保留已保存的提交编号。接收端可能已经接管实验；应先查询该编号的状态，再决定是否通过 `cancel_experiment` 取消远端运行。

Web 与无人值守 profile 中的活动 Goal 都拒绝人工提问、审批请求以及由 Agent 发起的插件变更；插件重载后仍会恢复这项限制。SSH 目标、路径与密钥引用均来自部署配置，模型工具参数不能修改。凭据缺失、未知 SSH 主机、构建失败、沙箱不可用或 CUDA 分配失败都会终止准备。

<a id="understand-the-implementation"></a>
## 实现

<details>
<summary>实现细节——点击展开</summary>

源码快照包含当前常规的已跟踪与未跟踪文件，排除凭据、依赖、构建输出和常见模型产物。内容摘要与选定服务器配置共同标识一次准备。本机通过短时 SSH 隧道访问远端经过认证的回环地址接收服务。提交前，本机存储域将一个提交编号固定到当前 Session、精确 Goal 版本、实验描述与服务器配置；响应丢失后重试使用相同编号与目标。完整的接收回执先保存，再完成本地 Goal。旧版本记录仍可读取，但未保存服务器的提交无法再访问，也不会绑定到后来的 Goal。

</details>

<a id="further-exploration"></a>
## 进一步阅读

接管后的生命周期见[工作端](../experiment-worker/README.zh.md)，文件限制见[沙箱子系统](../../../docs/subsystems/sandbox.zh.md)。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

认证接收端拥有持久去重记录；本机记录只保存重试编号。两者不是相互维护的派生视图，因此本包不发布单独的运行时 invariant。

</details>

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### What the model sees

本机 Agent 在系统上下文中看到以下派发指令。

##### 派发指令

```markdown
For a requested remote training experiment, prepare the environment, then submit explicit requirements only when preparation returns state ready. Preserve the user's chosen model, data, method and constraints. Choose missing details within authorized resources and record them. After submit returns accepted, the remote Goal owns execution; include the handover field verbatim when reporting its identifiers and status lookup. Never wait for a human response or claim the training finished from the acceptance receipt.
```

#### Token effect

固定指令在本机每次模型请求中占用少量 Token。

#### KV Cache effect

该插件配置保持启用时，指令作为稳定前缀重复使用。

### 实验工具

#### What the model sees

本机 Agent 可以调用 `prepare_experiment_environment`、`submit_experiment`、`get_experiment_status` 和 `cancel_experiment`；参数见[生成的 Schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experiment-dispatch)。结果包含 JSON 准备报告或持久接收记录；远端模型历史保存在独立 Session 中。

#### Token effect

四项固定定义进入本机工具目录；每次结果按返回报告的大小占用 Token。

#### KV Cache effect

定义在多次请求间保持稳定，变化的回执与状态只进入后续历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

在以下限制内支持本机文件传输及已存在的远端工作目录输入。

- 每个工作端只能同时运行一项实验，不调度多个目标。
- 成功回执仅在原本地 Goal 的编号和版本仍匹配时完成它；编辑后的 Goal 需要重新提交。
- 工作进程重启后保留中断记录，但不自动恢复 GPU 训练。
- 训练质量的独立 Verify 评估由后续阶段实现。
