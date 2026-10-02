# 验证

[English](verification.md) | 中文

## 概要

修改代码、生成的 Remote、依赖版本或发布文件后，运行独立工程的检查。本地夹具无需模型凭据或 GPU，即可验证调度、DSH 接入和服务生命周期，但不能证明 CUDA、真实框架训练或多节点集合通信正确。

## 目录

- [本地检查](#local-checks)
- [GPU 验收](#gpu-acceptance)

-----

<a id="local-checks"></a>
## 本地检查

冻结安装后在本工程内运行。先构建，再运行 profile 检查，使其使用当前的发布产物。

```text
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:api
pnpm run test:worker
pnpm run test:control
pnpm run test:web
pnpm run test:installed
pnpm run build:desktop
pnpm run test:desktop:api
pnpm run test:desktop
```

单元测试采用独立状态目录、受管进程替身和系统分配的网络端口，覆盖整组分配及先后顺序、重启结果不明、固定重试身份、服务器配置固定、拒绝误完成编辑后的 Goal、取消竞争、输入大小及摘要、密码传输、文件范围、下载取消、UTF-8 游标和服务停止及健康检查竞争。符号链接逃逸夹具在 Linux/macOS 运行，在 Windows 跳过。

`test:api` 使用真实派发适配器启动正式管理 profile，通过认证读取旧版服务器登记和实验列表。`test:desktop:api` 使用现有应用目录、升级后的 profile，以及仓库外的中文状态路径，验证同一服务器 API，并通过真实表单保存服务器。两项检查均不创建发布 ZIP，也不替换派发适配器。

`test:worker` 通过无密钥回放提供方启动正式 worker profile，检查实际规划及执行工具列表、输入访问拒绝、声明输入读取、框架知识、持久计划及执行记录和 [Session 快照](../scripts/fixtures/worker.snapshot.json)。自动执行 Agent 无法使用通用命令、插件安装或人工等待。续行回放跨过原 128 轮限制，验证所有延长均记入日志，且 Session 和 Goal 不变。

`test:control` 使用真实存储域启动正式调度和规划 worker，验证真实问题持久化、暂停时模型调用不增长、并发相同回复、拒绝冲突及取消后回复、恢复同一 Goal，以及认证接收、完整接管、不占资源的计划在调度重启后保留、删除暂存输入后的相同重试、拒绝修改内容、拒绝遗留执行及取消。[问题 Session 快照](../scripts/fixtures/control.snapshot.json)记录持久化问题、回复、原工具结果及 Goal 转换。仅因计划等待确认而采用模拟节点清单，不启动 GPU 命令。

`test:web` 使用真实的已发布 Web 组合和生成的普通及流式 Remote，部署由明确的 CPU 提供方模拟。覆盖密码表单、附件、独立 Goal、计划确认、并行及共享排队、接管说明及[派发快照](../scripts/fixtures/session.snapshot.json)、重连及轮转、会话隔离、文件下载、实际私有 HTTP 服务访问、浏览器断开、停止、异常退出、取消及错误展示，以及问题卡、待处理数量、断线保留和回复后继续同一实验。服务本身使用独立的 `dsh` profile 进程，截图保存到 `.artifacts/`。

`test:installed` 打包构建产物，在仓库外安装冻结的生产依赖，检查 NodeNext 使用方类型，从安装目录重新打包，并启动正式 profile。检查客户端声明、侧栏注册、用户名及密码字段和实时 Remote 快照。测试需要已安装的浏览器和已填充的 pnpm 缓存；生产派发需要访问配置的依赖包仓库。

-----

[桌面指南](../apps/desktop/README.zh.md#build-and-verify)说明打包后的 Electron 验证及 Windows 应用限制。桌面端复用 Web 的实验服务及记录的 Session 投影。

-----

<a id="gpu-acceptance"></a>
## GPU 验收

本次交付没有可用 GPU 服务器。GPU 操作人员使用两台互通的 Linux 节点验收，提前信任 SSH 主机密钥，并将密码保存在管理 profile 的私有凭据存储中。

1. 探测两个节点，验证 bubblewrap 拒绝目录外写入及私有凭据读取，并使用获准 CUDA 设备完成短计算。
2. 派发不同节点的任务、共享节点的排队任务和一个联合任务。确认固定 rank、实际集合通信和固定框架版本的短训练，检查记录的脚本、环境、参数及实测输出。
3. 接管后断开并关闭管理机器，验证远端调度服务接续排队任务、执行并保存结果，无需管理端在线。
4. 将训练产物加载到登记的回环推理服务中，验证实际预测、健康检查、服务器持续占用、停止清理及排队任务推进。
5. 在排队和服务观察期间重启调度服务，再验证节点失败、取消竞争和回执丢失，确保不重复训练、不改变服务器组、不在确认清理前释放资源。

记录准确的节点、驱动和框架版本、发布身份、命令、日志及评估输出。无法核实的进程身份保持中断状态，等待操作人员核对，不能作为自动重试的验收路径。
