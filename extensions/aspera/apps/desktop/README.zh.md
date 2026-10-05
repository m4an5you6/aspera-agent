# Aspera 桌面端

[English](README.md) | 中文

## 概要

在桌面窗口中管理 Aspera 实验，从 Windows 托盘重新打开，并在退出后保持已接管的远端实验运行。Windows x64 本地构建包含完整管理运行时，无需另外安装 Node 或 pnpm。

## 目录

- [运行](#run)
- [构建与验证](#build-and-verify)
- [实现](#implementation)
- [限制](#limits)

-----

<a id="run"></a>
## 运行

打开 `win-unpacked/Aspera.exe`，并完整保留其应用目录。在 DSH 中配置模型，并从侧栏打开 **Aspera**。服务器设置见[工程指南](../../README.zh.md#submit-an-experiment)。

关闭窗口会隐藏到 Windows 托盘，本机管理 Host 继续运行。托盘及应用菜单可以重新打开窗口或退出。退出等待本机 Host 清理；已接管的远端实验和服务仍由远端管理。本地对话及尚无接管回执的提交仍依赖本应用。

桌面端将状态保存在 `%APPDATA%/Aspera`，Harness 数据位于 `dsh`。服务器在这个独立 home 中配置。`ASPERA_DESKTOP_USER_DATA_DIR` 指定其他桌面状态根目录，`ASPERA_HOME` 指定其他 Harness home。每个 Harness home 同时只运行一个管理进程。

Windows 任务栏叠加图标显示需要计划确认或回复的实验数量：`1–99`，超过显示 `99+`，归零清除。隐藏窗口时托盘图标也更新。无需打开 Aspera 即可刷新数量。应用完全退出期间不能更新徽标，重新启动后从远端持久状态恢复计数。

-----

<a id="build-and-verify"></a>
## 构建与验证

使用[工程前置条件](../../README.zh.md#start-the-management-page)，在 `extensions/aspera` 中执行下列命令。

```text
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm run test:desktop:api
pnpm run test:desktop
pnpm run start:desktop
```

输出为 `.artifacts/desktop-0.1.1/<build-id>/win-unpacked/Aspera.exe` 和 `aspera-desktop-build.json`，不生成 ZIP，`latest.json` 指向最近成功构建。记录包含可执行文件及运行时的 SHA-256、构建标识、固定的 DSH／Aspera／Electron 版本、第 4 代控制协议、第 6 代本机管理存储、第 4 代远端存储和远端发布摘要。程序内含 `resources/build-info.json`。暂存目录使用 `.artifacts/desktop-build-*`，首次下载依赖需要网络。

桌面验证默认使用最近的构建，也可通过 `ASPERA_DESKTOP_BUILD_ID` 指定构建目录。

构建中断后，设置 `ASPERA_DESKTOP_STAGE=.artifacts/desktop-build-<id>` 可复用该暂存目录，前提是其冻结发布摘要仍与当前构建相同。构建会重新检查生产锁文件并封装运行时，已完成的输出目录各自独立。

打包验证使用私有 home，检查官方标题栏和字号，通过真实插件页面安装本地 bundle，并验证重启后加载。同时检查从封装运行时生成完整派发材料、原生快捷键、菜单关闭、渲染器隔离、托盘可见状态及 Host 退出回收。`node scripts/measure-desktop.mjs --runs=3 --assert-fixed` 将首个窗口、应用文档及可用页面的耗时记录到 `.artifacts/desktop/startup-measurement.json` 及按版本保存的报告。每个样本使用新的 home 和凭据存在状态测试值，不执行模型任务。文件缓存及 Windows 启动波动仍会影响测量。[验证说明](../../docs/verification.zh.md)介绍 Web、调度及 GPU 覆盖。`ASPERA_DESKTOP_STARTUP_MS` 和 `ASPERA_DESKTOP_SHUTDOWN_MS` 默认是 60000 和 30000 毫秒，接受 1000 至 2147483647 之间的整数。

-----

<a id="implementation"></a>
## 实现

Electron 管理窗口和托盘，其 Node 模式子进程通过已发布的 DSH profile runner 启动 `aspera-desktop`，不导入上游 Desktop 源码。浏览器认证将私有启动 token 换为 cookie。隔离的渲染器没有 Node 集成；适配器提供外观、应用／编辑菜单和已发布的 Desktop 快捷键协议，设备偏好通过原子文件写入保存。引导只通过已认证 RPC 查询模型凭据的存在状态。原生操作校验获准的顶层页面。页面停留在本机回环来源，通过系统浏览器打开无凭据的 HTTPS 链接，浏览器权限默认拒绝。

`runtime.asar` 保存冻结的生产依赖和 pnpm，原生二进制及 pnpm 位于解包目录。可写 profile 保存外部插件依赖和启用选择。DSH 共享解析器使用同时声明 Aspera 包和官方可选 DSH 插件的运行时清单；打包时从固定版本的 DSH 安装中读取可选插件名称和版本。用户目录不需要源码仓库或第二份核心依赖。插件使用内置 pnpm 安装，启用变更在重启后生效；文件监听 HMR 关闭。应用补丁与用户补丁分开。升级先备份旧配置，再移除经验证的运行时链接和应用生成的管理限制，见[升级说明](../../docs/desktop-upgrade.zh.md)。框架环境仍在远端节点，已发布的浏览目录选择器提供目录选择。

[架构图](../../docs/architecture.zh.md#architecture-diagrams)展示模块归属及接管。策略及 profile 测试拒绝非法 IPC 地址、不安全导航、带凭据的链接及被修改的归属。私有 IPC 在 Windows 中调用 CLI 的正常退出信号处理，桌面壳等待 Host 结束。

-----

<a id="limits"></a>
## 限制

交付为未签名的完整 Windows x64 程序目录，不含安装器、更新源或对外发布。macOS 和 Linux 包尚未验收。桌面壳复用 DSH 客户端账号、引导和设置页面，不包含上游桌面的原生账号窗口、自动更新或嵌入式 Platform 浏览器。GPU 训练和多机同步仍需实机验收。
