# Aspera 扩展

[English](README.md) | 中文

## 概要

从 Aspera 侧栏提交独立的训练或推理 Goal，确认计划、查看节点日志并下载实验产物。一个远端调度主机负责整组服务器的分配，登记的推理服务在 Agent 结束后继续运行。本工程独立构建，依赖已发布的 DSH `0.2.0-rc.2` 包。GPU 执行需要完成[验证说明](docs/verification.zh.md)中的独立验收。

## 目录

- [启动管理页面](#start-the-management-page)
- [构建桌面应用](#build-the-desktop-application)
- [提交实验](#submit-an-experiment)
- [开发与升级](#develop-and-upgrade)
- [进一步阅读](#further-exploration)

-----

<a id="start-the-management-page"></a>
## 启动管理页面

使用 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`。从仓库根目录运行下列命令，依赖和构建产物保存在本工程内。

```text
cd extensions/aspera
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:web --no-open
```

打开 DSH 打印的地址，完成初始配置，然后选择侧栏中的 **Aspera**。启动脚本在 `.dsh-home` 下建立 `aspera` profile；设置 `ASPERA_HOME` 可以使用另一个独立状态目录。模型凭据保存在该 profile 的 DSH 凭据提供方，默认移交引用为 `DEEPSEEK_API_KEY`。提交前选择固定 worker profile 已配置的提供方和模型。

管理端支持 Windows；执行节点需要 Linux、密码 SSH 登录、管理用户 `~/.ssh/known_hosts` 中已信任的主机密钥、Node/pnpm、NVIDIA 设备和可用的 bubblewrap。派发前在服务器上安装这些依赖。多节点实验还需要互通的训练网络地址。CUDA、隔离或网络检查不通过时，执行被阻塞并记录错误。

-----

<a id="build-the-desktop-application"></a>
## 构建桌面应用

在本工程中构建并验证独立的 Windows 应用。

```text
pnpm run build:desktop
pnpm run test:desktop
```

Aspera `0.1.1` 输出到 `.artifacts/desktop-0.1.1/<build-id>/`，`latest.json` 标明最近成功的构建。完整保留应用目录并运行 `win-unpacked/Aspera.exe`，打包不生成 ZIP。包内包含 Electron、DSH、Aspera 和 pnpm。[桌面指南](apps/desktop/README.zh.md)说明内容摘要和构建限制，[架构图](docs/architecture.zh.md#architecture-diagrams)说明模块与执行关系。

-----

<a id="submit-an-experiment"></a>
## 提交实验

1. 打开**服务器**，填写名称、SSH 地址、端口、用户名和密码。高级设置提供自动或手动存储、可选内网 IP 或主机名，以及控制端口（默认 `43019`，调度服务使用下一端口）。没有指定位置要求时，保留存储和网络自动设置。首次添加的服务器固定担任调度主机，也可以参与实验。
2. 保存后点击**检查连接**。保存只记录设置和独立的只写密码；检查读取 SSH、GPU、磁盘及网络信息，不调用模型。编辑已有服务器时留空密码会保留已保存的值。持久性未知不能作为云盘持久保存的保证。
3. 打开**新建实验**，填写自然语言 Goal，选择一台或多台服务器，添加输入附件并选择执行方式。默认全自动，两种模式都无需填写任务预算。
4. 提交后可以继续创建实验。派发 Agent 从探测结果选择磁盘并记录理由，保存后才创建目录。优先使用空间足够的数据盘，也允许空间足够的系统盘。详情显示实际目录、可用空间和验证后的内网地址。半自动模式在**确认此计划**之后才下载模型或训练，等待确认时不预留节点。
5. 远端持久接收后，详情和派发 Session 显示**本机派发完成，远端实验已接管**。这表示派发完成；实验仍可能处于准备计划、排队、运行或服务中。
6. 需要对外推理时，在服务器表单展开**推理服务对外访问（可选）**，填写平台 HTTPS 基础地址及其映射的容器／服务器内部端口。新实验会固定此映射；在 Goal 中说明需要对外推理。服务详情分别展示本地健康与外部连通状态，点击**查看调用信息与密钥**获取当前服务的独立调用密钥。
7. 详情页提供计划、执行消息、节点日志、输出文件清单和私有推理请求。按需下载文件。停止服务或取消实验后，确认清理完成才释放服务器。

使用**待处理**查找计划确认和持久保存的问题。半自动遇到无法自主解决的选择时暂停新的 Agent 操作，回复问题卡后继续原实验。打开问题卡不会清除标识。全自动自主调查并重试可恢复故障，不等待回复。两种模式保留取消、沙箱和循环保护；[运行时说明](packages/runtime/README.zh.md)定义续行和失败行为。

使用**复制为新实验**修改已提交的目标、模型、数据集、训练方式或服务器选择，复制会保留原模式。共享服务器按远端接收顺序排队，不共享服务器的任务可以并行。服务中的实验保留完整服务器组，页面列出其阻塞的排队实验。

-----

<a id="develop-and-upgrade"></a>
## 开发与升级

四个包分别负责[记录与调度](packages/experiments/README.zh.md)、[节点及 Agent 执行](packages/runtime/README.zh.md)、[DSH 接入](packages/dispatch/README.zh.md)和 [Web 页面](packages/console/README.zh.md)。导入只指向已发布的 DSH 包，不引用上游源码路径。框架知识以运行时技能发布，Agent 选择的参数通过短运行和实际评估检查。

```text
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:worker
pnpm run test:control
pnpm run test:web
pnpm run test:installed
pnpm run pack
```

浏览器验证默认使用已安装的 Chrome；`ASPERA_BROWSER_CHANNEL` 可选择其他已安装的 Playwright 通道。独立安装验证在源码仓库外解包发布文件，使用本机 pnpm 缓存。`pack` 将按内容寻址的发布文件写入 `.artifacts/`，远端派发使用同一打包流程。

升级 DSH 时，更新精确依赖版本和锁文件，检查生成的 Remote 及浏览器兼容代码，再执行这些检查并发布新的扩展版本。在途实验结束前保留原发布目录和运行中的控制进程。状态及协议的兼容性决策记录在[版本化数据说明](docs/state-and-api.zh.md)中。

第 3 代存储与协议兼容方式见 [0.1.1 升级指南](../../docs/upgrade-guide/v0.2.0-rc.2/aspera-storage-v3/guide.zh.md)。新准备记录失败后可使用**重试准备**，保留原任务身份和目录；挂载、输入或构建变化时需修复原因或新建实验。`aspera-ext-spike` 仅保留历史验证用途，开发和打包使用本工程。

-----

<a id="further-exploration"></a>
## 进一步阅读

- [架构与扩展位置](docs/architecture.zh.md)
- [状态、回执与接口](docs/state-and-api.zh.md)
- [本地验证与 GPU 验收](docs/verification.zh.md)
- [MIT 许可](LICENSE)
