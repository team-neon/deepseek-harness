---
description: "crawl 包分组：可选的财联社电报抓取，供选择或浏览该能力系列的读者使用。"
kind: "package-group"
---

# crawl/ — 财联社电报抓取

[English](README.md) | 中文

## 概述

本组包含可选的财联社电报抓取包。profile 挂上这个包，并且设置 `NEONQUANT_CRAWL_ROOT`，抓取才会启用。随附的默认 profile 不挂载这个包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

一个可选 bundle。profile 挂上这个包且设置了 `NEONQUANT_CRAWL_ROOT` 时，抓取才会运行。

| 包 | 职责 |
|---|---|
| [`crawl-cls`](crawl-cls/README.zh.md) | 财联社电报抓取层 |

<a id="related-documentation"></a>
## 相关文档

- [app-boot](../boot/app-boot/README.zh.md) — profile 如何叠放 bundle 补丁层。
- [产品包策略](../../scripts/product-package-policy.ts) — 这个包的 optional 分类。

<a id="dev-note"></a>
## 开发备注

无。
