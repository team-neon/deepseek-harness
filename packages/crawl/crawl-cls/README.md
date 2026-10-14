---
description: "Optional Cailian Press telegraph crawl layer. A profile adds the bundle, and NEONQUANT_CRAWL_ROOT enables it."
kind: "package-bundle"
---

# @deepseek-ai/dsh-crawl-cls

English | [中文](README.zh.md)

## Summary

This optional bundle crawls Cailian Press telegraphs into files. A profile mounts the package, and `NEONQUANT_CRAWL_ROOT` enables the crawl. Shipped acp, web, headless, sdk, and sdk-minimal profiles leave it out.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the package to a profile bundle list to apply [`cordis.patch.yml`](cordis.patch.yml). The patch stays disabled until `NEONQUANT_CRAWL_ROOT` is an absolute data directory. Shipped default profiles do not list this package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) mounts the crawl when `NEONQUANT_CRAWL_ROOT` is set. [`src/index.ts`](src/index.ts) registers `cls_telegraph_sync` and runs one round on the configured interval.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [crawl group](../README.md) — the family map for this package.
- [app-boot](../../boot/app-boot/README.md) — how profiles layer bundle patches.

-----

<a id="model-experience"></a>
## Model Experience

### Telegraph sync tool

#### What the model sees

`cls_telegraph_sync` takes no arguments. Its description is `Sync the latest Cailian Press telegraph items into the configured crawl directory. Returns created, updated, unchanged, and rejected counts for that round.` The result fields are `created`, `updated`, `unchanged`, and `rejected`.

#### Token effect

The tool definition and the returned counts contribute tokens when the tool is available and the model calls it.

#### KV Cache effect

Registering the tool changes the tool-list prefix. A call appends ordinary tool-call history and does not replace earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Shipped default profiles do not mount this package. The crawl writes files under `NEONQUANT_CRAWL_ROOT`, and `cls_telegraph_sync` returns counts only.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
