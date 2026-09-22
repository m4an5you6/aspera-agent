# Agent Note: 移除 Electron 桌面应用

Status: implemented

[English](2026-09-21-remove-electron-desktop.md) | 中文

## 问题

仓库曾随附 Electron Desktop 壳、私有 Desktop Host、签名安装包，以及与 Web、Headless、SDK、ACP profile 并列的保留 `$DSH_HOME/profiles/desktop`。该产品负责打包、公证、更新策略、Darwin 与 Windows 窗口框架，以及 preload 目录选择桥。维护它会把交互 GUI 拆成两条载体，而 Web 应用已经提供同一套 Host、RPC 与客户端插件。

## 决策

仓库不包含 `apps/desktop`、`apps/desktop-host`、Electron osx-sign 补丁、Desktop 打包与上传脚本，以及仅用于 Desktop 的客户端窗口框架。仓库不提供 Electron 应用、不保留 `desktop` profile，也不提供仅用于 Desktop 的 API 或桩。交互 GUI 用户启动 `dsh web`。Headless、SDK、ACP、文档网站和 agent 工具保留。

浏览器 Web 入口是唯一的 GUI 引导：`apps/web` 挂载 `AppWebEntry`，不注入 Desktop 启动事实。原生目录选择只使用 Host `pickDirectory()`。设置中的连接状态保留；Desktop 更新徽标不保留。布局与侧栏不再应用 Darwin 隐藏标题栏或 Windows 顶栏框架。

共享的操作系统桌面能力保留：Host `open-in-app`、原生路径打开、Linux `.desktop` 条目、computer-use 和 `workspaceDesktop()`。用户的 Harness home 与会话既不迁移也不删除。

被取代的 Desktop 已实施笔记在本次变更中归档。过时的 Desktop 更新与卸载提案直接删除，而不是作为拒绝记录保留，因为它们所扩展的产品已不存在。[沙箱化 Sidebar 浏览器](../feature/2026-09-16-sidebar-browser.zh.md)仍是 iframe Browser 的归属；其延期的 Electron `<webview>` 设计不是当前行为。

## 考虑过的替代方案

**保留 Desktop 并继续 Electron 发布线。** 这能保留签名安装包和无需系统 Node 的 GUI，但仍要维护 Electron 打包、公证、更新策略和第二套 Host 进程。移除用单一交互入口换取放弃该载体。

**用 TUI 替换 Electron。** 终端界面是另一种产品面。本次变更不引入 TUI。

**把仅用于 Desktop 的 API 留成桩。** 桩会把已移除的载体呈现为仍可用，并让测试与文档继续描述它。缺席才是已交付约定。

**把 Desktop 迁到独立仓库。** 这能在不于此仓库交付的前提下保留代码。本树删除该产品，而不是搬迁它。

## 后果

已有 Desktop 安装与 `$DSH_HOME/profiles/desktop` 不会获得迁移、更新器或 CLI 管理。依赖 Desktop Host overlay、preload 桥或 Electron 窗口框架的自定义组合会失去这些表面。Web、Headless、SDK 和 ACP 继续共享同一套会话与设置数据根。

重新引入 Electron 或其他原生 GUI 需要新的 Agent Note、完整的应用树，以及证明它不会在没有所属载体的情况下复活仅用于 Desktop 的客户端 API。

## 验证

代码树中不存在 `apps/desktop`、`apps/desktop-host`，工作区也不依赖 `electron` / `electron-builder`。`pnpm run build`、`pnpm run typecheck`、`pnpm run lint`、针对性 hygiene、`pnpm run test:docs`、`pnpm run website:build`、GUI 测试以及无密钥 Headless/SDK/ACP 冒烟覆盖剩余表面。已删除的 Desktop 测试不为得到的代码树提供证据。
