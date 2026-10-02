# 桌面升级

[English](desktop-upgrade.md) | 中文

## 概要

Aspera `0.1.1` 保留现有 Harness 状态目录及外部插件管理。先完全退出旧程序，使用完整的新应用目录，再运行 `win-unpacked/Aspera.exe`。每次构建的独立标识和 SHA-256 写入 `aspera-desktop-build.json`，程序内附 `resources/build-info.json`。应用版本编号不会改写历史 `0.2.0` 回执，也不改变桌面 profile 的归属标记。

## 目录

- [Profile 变化](#profile-changes)

-----

<a id="profile-changes"></a>
## Profile 变化

profile 归属标记从版本 1 升级为 2。升级先验证旧包链接，再解除链接；将 `cordis.patch.yml` 备份为 `cordis.patch.v1.yml`，移除应用生成的管理限制，并将应用补丁与用户设置分开。链接被修改或包目录归属不明时，启动停止，等待核对。已有实验、凭据、工作区和 Session 存储保留。

外部包安装在可写 profile 内，固定运行时位于 `runtime.asar`。安装或切换插件后重启生效，运行时文件监听仍关闭。不要让两个版本同时使用同一 Harness home，也不要在 profile 升级后重新打开旧版程序。
