---
description: "可选的财联社电报抓取层。profile 加入该 bundle，NEONQUANT_CRAWL_ROOT 启用它。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-crawl-cls

[English](README.md) | 中文

## 概述

这个可选 bundle 把财联社电报抓成文件。profile 挂上这个包，并且设置 `NEONQUANT_CRAWL_ROOT`，抓取才会启用。随附的 acp、web、headless、sdk 与 sdk-minimal profile 不包含它。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

把该包加入 profile 的 bundle 列表，以应用 [`cordis.patch.yml`](cordis.patch.yml)。在 `NEONQUANT_CRAWL_ROOT` 成为绝对数据目录之前，补丁保持禁用。随附的默认 profile 不列出这个包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在设置了 `NEONQUANT_CRAWL_ROOT` 时挂上抓取。[`src/index.ts`](src/index.ts) 注册 `cls_telegraph_sync`，并按配置的间隔跑一轮。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [crawl 分组](../README.zh.md) — 这个包所属的能力系列地图。
- [app-boot](../../boot/app-boot/README.zh.md) — profile 如何叠放 bundle 补丁。

-----

<a id="model-experience"></a>
## 模型体验

### 电报同步工具

#### 模型可见内容

`cls_telegraph_sync` 不接受参数。它的描述是 `Sync the latest Cailian Press telegraph items into the configured crawl directory. Returns created, updated, unchanged, and rejected counts for that round.` 结果字段是 `created`、`updated`、`unchanged` 和 `rejected`。

#### Token 影响

工具可用且模型调用它时，工具定义和返回的计数贡献 token。

#### KV Cache 影响

注册该工具会改变工具列表前缀。一次调用追加普通工具调用历史，不替换更早的请求 token。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 随附的默认 profile 不挂载这个包。抓取把文件写到 `NEONQUANT_CRAWL_ROOT` 下，`cls_telegraph_sync` 只返回计数。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
