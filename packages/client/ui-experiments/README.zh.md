---
description: "Web 服务器管理、独立实验列表、详情、日志及文件下载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-experiments

[English](README.md) | 中文

## 概述

此 Web 插件在侧栏添加实验入口。用户管理密码登录服务器，向所选节点提交独立 Goal，并查看各实验的回执、排队状态、日志、错误和输出文件。Host 任务服务拥有持久化和执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开实验并添加服务器，然后选择新建实验。多选服务器表示联合执行。已提交任务可以取消或复制为新草稿。文件内容按需下载；选中实验会获取元数据和有限日志尾部。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

控制器将生成的 Remote 方法连接到快照存储。页面可见时才轮询，持久变更事件和连接重置触发刷新。字节游标与 UTF-8 解码器按实验及来源隔离，卸载后忽略迟到回复。页面通过注入接口接收操作，通过类型化本地化字典获取产品文字。

</details>

<a id="further-exploration"></a>
## 延伸探索

凭据和接管语义见[派发服务](../../workflow/experiment-dispatch/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 用户编写的目标

#### 模型看到的内容

浏览器向派发服务发送用户编写的 `Goal`，不添加模型指令或工具定义。

#### Token 影响

此展示包不增加 Token。

#### KV Cache 影响

界面渲染不会增加模型请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 复制任务时需要重新选择浏览器附件，可配置轮询和保留文字上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>实现细节 — 点击展开</summary>

不发布运行时不变量伴随包：控制器展示 Host 记录，不拥有独立执行状态。

</details>
