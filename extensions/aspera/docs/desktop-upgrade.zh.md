# 桌面升级

[English](desktop-upgrade.md) | 中文

## 概要

Aspera `0.1.1` 保留现有 Harness 状态目录及外部插件管理。先完全退出旧程序，使用完整的新应用目录，再运行 `win-unpacked/Aspera.exe`。每次构建的独立标识和 SHA-256 写入 `aspera-desktop-build.json`，程序内附 `resources/build-info.json`。应用版本编号不会改写历史 `0.2.0` 回执，也不改变桌面 profile 的归属标记。

## 目录

- [Profile 变化](#profile-changes)
- [控制进程就绪检查](#controller-readiness)

-----

<a id="profile-changes"></a>
## Profile 变化

profile 归属标记从版本 1 升级为 2。升级先验证旧包链接，再解除链接；将 `cordis.patch.yml` 备份为 `cordis.patch.v1.yml`，移除应用生成的管理限制，并将应用补丁与用户设置分开。链接被修改或包目录归属不明时，启动停止，等待核对。已有实验、凭据、工作区和 Session 存储保留。

外部包安装在可写 profile 内，固定运行时位于 `runtime.asar`。安装或切换插件后重启生效，运行时文件监听仍关闭。不要让两个版本同时使用同一 Harness home，也不要在 profile 升级后重新打开旧版程序。

配套桌面资源包含封存的部署归档，创建实验前会核对归档与已安装扩展文件的一致性。从这些资源派发时，清理本机 pnpm 元数据缓存不再阻止部署；源码构建可以补取固定包缺少的元数据。尚未保存发布和远端目录的准备失败支持原地重试；已有固定发布和已提交实验保留原身份。更新资源前必须完全退出 Aspera，保留原 EXE 和资源备份。

启动 Host 前，桌面端将 profile 的 `package.json` 中缺失的 `name` 补为 `aspera-desktop-profile`，缺失的 `version` 补为桌面应用包版本。已有名称、版本、依赖、bundle 及用户补丁保留。显式填写为空或非字符串的身份字段会阻止启动，需修正后继续。归属标记保持第 2 代。DeepSeek 插件清单因此能识别桌面生命周期模块，无需关闭请求扩展。完全退出并重新打开更新后的应用即可修复；已有对话可直接重试，无需复制实验。

运行资源更新也修复 DeepSeek 阶段快照。保留私有配置记录及哈希，重启 Aspera，并在尚未保存固定发布时重试准备。已经固定的远端发布保留原读取器；参见[模型快照恢复](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-model-snapshots/guide.zh.md)。

-----

<a id="controller-readiness"></a>
## 控制进程就绪检查

[存储治理更新](storage-governance.zh.md#records-and-compatibility) 同样要求 Host、runtime 和 Web 资源一致。先构建资源，完全退出 Aspera 后应用更新，保留原可执行文件。旧远端实验保留封闭发布；确认释放后，复制实验取得存储、历史借用和受管材料能力。

[完成复验资源更新](completion-review.zh.md) 继续使用原 EXE。应用资源前应完全退出 Aspera，保留原固定发布、失败结果和证据文件。历史复验不重新训练，也不升级远端任务。

对应的资源更新增加 GPU 身份检查和准备 Agent 发起的空闲控制进程修复，保留当前执行文件。保留原远端发布和已提交实验。启动授权未知或缺少安全维护能力的控制进程需要按提示释放任务、停止进程；封存发布不被覆盖。中断修复保留独立回执和尝试上限。见[控制进程就绪升级](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-controller-readiness/guide.zh.md)。
