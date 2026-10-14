---
description: "The crawl package group: the optional Cailian Press telegraph crawl, for readers choosing or navigating the family."
kind: "package-group"
---

# crawl/ — Cailian Press telegraph crawl

English | [中文](README.zh.md)

## Summary

This group holds the optional Cailian Press telegraph crawl package. A profile mounts this package, and `NEONQUANT_CRAWL_ROOT` enables the crawl. Shipped default profiles leave the package unmounted.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One optional bundle. The crawl runs when a profile mounts this package and `NEONQUANT_CRAWL_ROOT` is set.

| Package | Role |
|---|---|
| [`crawl-cls`](crawl-cls/README.md) | Cailian Press telegraph crawl layer |

<a id="related-documentation"></a>
## Related documentation

- [app-boot](../boot/app-boot/README.md) — how a profile stacks bundle patch layers.
- [Product package policy](../../scripts/product-package-policy.ts) — the optional classification for this package.

<a id="dev-note"></a>
## Dev Note

None.
