---
description: "使用独立 Aspera Web 侧栏配置服务器、确认实验、续读日志、获取产物并管理推理服务。"
kind: "package-reference"
---

# @aspera/console

[English](README.md) | 中文

## 概要

在独立页面管理远端实验，同时保持普通对话可用。添加密码服务器、连续提交 Goal、确认计划，并查看进度、回执、消息、节点日志和输出。通过私有连接访问及停止推理服务，显示其阻塞的排队实验。Host 管理任务状态，浏览器卸载只结束页面效果。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

派发 bundle 在独立[管理 profile](../../README.zh.md#start-the-management-page) 中注册本插件。包声明将 `./client` 投影到 Web 客户端，使用独立 Host/客户端编译程序和公开客户端声明。不修改对话路由、上游页面或自定义事件白名单。

[Config](src/config.ts) 配置页面轮询、保留文本长度及新服务器表单的初始控制端口。文本长度只限制展示的末尾内容，不限制远端文件。[AsperaRemote](../dispatch/src/index.ts) 提供操作默认值和已验证状态，类型化的中英文字典负责所有产品标签。

切换实验或连接重置时，控制器保留按实验、节点及来源区分的解码器和字节游标，明确显示日志缺失及轮转。复制已提交实验会创建新请求，确认及取消使用显示的实验身份。推理请求通过受管理的连接获取有界响应，模型产物下载前仍保存在文件中。

页面复用 DSH 字体、明暗主题变量及 Button、Input、Checkbox、Tag、Modal 和浮层 Menu。可选的推理对外访问区域记录平台 URL 及映射内部端口，服务卡片区分本地健康与外部检查。调用密钥仅在操作人员主动查看时展示。服务器弹窗常规区域保留五个 SSH 字段，高级设置包含自动／手动存储、可选内网地址和控制端口。展开的内容在窗口内滚动，保存按钮始终可达。最近探测展示空间、写入能力及未知持久性。实验详情在计划确认旁展示准备阶段、保存目录、网络地址和理由。新建及复制实验保留所选执行模式。

即使没有打开 Aspera，控制器也会刷新待处理状态。侧栏、列表和桌面接收同一份按实验去重的数量，包括计划确认和未回答问题；阅读卡片不表示已处理。较重的日志和文件读取仅针对可见的选中实验。桌面计数通过经过校验的私有接口传递。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

[client/index.ts](src/client/index.ts) 管理 Remote 描述、流卸载、字典及样式注册、侧栏及页面插槽；[controller.ts](src/client/controller.ts) 合并刷新、拒绝过期结果并限制展示文本；[ExperimentsPage.tsx](src/client/ExperimentsPage.tsx) 通过注入参数接收动作及状态；[conversation.ts](src/client/conversation.ts) 按 Session ID 及序号隔离完整记录。服务端解析与浏览器行为测试执行归属检查，不发布仅检查存在的 invariant 入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [启动工程](../../README.zh.md)
- [Host 接入](../dispatch/README.zh.md)
- [浏览器及独立安装验证](../../docs/verification.zh.md)

<a id="model-experience"></a>
## 模型体验

无：本包展示管理状态并向共用的 Host 服务提交明确操作，远端 Agent 通过运行时获取已记入日志的要求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- Web 与 Desktop 通过已有侧栏和主面板插槽展示同一页面。
- 优先显示实测进度指标，缺少时显示阶段及原始日志，不推测训练百分比。
- 浏览器保留内容有界，下载期间文件代次必须保持稳定。

### 开发备注

无。
