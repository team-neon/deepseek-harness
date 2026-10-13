---
description: "可选的财联社电报抓取层。profile 加入该 bundle，NEONQUANT_CRAWL_ROOT 启用它。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-crawl-cls

[English](README.md) | 中文

## 概述

这个可选 bundle 预留财联社电报抓取层。随附的 acp、web、headless、sdk 与 sdk-minimal profile 不包含它。把该包列入 profile 后，会应用 `cordis.patch.yml`。这份骨架里的补丁列表是空的。

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

把该包加入 profile 的 bundle 列表，以应用 [`cordis.patch.yml`](cordis.patch.yml)。随附的默认 profile 不列出这个包。这份骨架里的补丁列表是空的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 是 profile 应用的 bundle 补丁。[`src/index.ts`](src/index.ts) 是路径别名解析到的包入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [crawl 分组](../README.zh.md) — 这个包所属的能力系列地图。
- [app-boot](../../boot/app-boot/README.zh.md) — profile 如何叠放 bundle 补丁。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该 bundle 不添加模型上下文、工具或提示词。

#### KV Cache 影响

该层不添加请求内容，因此已有缓存前缀仍可复用。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- bundle 补丁列表是空的，因此选中这个包不会开始抓取。随附的默认 profile 不包含它。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
