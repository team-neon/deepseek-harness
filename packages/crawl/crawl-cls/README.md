---
description: "Optional Cailian Press telegraph crawl layer. A profile adds the bundle, and NEONQUANT_CRAWL_ROOT enables it."
kind: "package-bundle"
---

# @deepseek-ai/dsh-crawl-cls

English | [中文](README.zh.md)

## Summary

This optional bundle is the Cailian Press telegraph crawl layer. Shipped acp, web, headless, sdk, and sdk-minimal profiles leave it out. A profile that lists the package applies `cordis.patch.yml`. NEONQUANT_CRAWL_ROOT enables the crawl when that layer is present.

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

Add the package to a profile's bundle list. The reconcile step applies [`cordis.patch.yml`](cordis.patch.yml). Shipped default profiles do not list this package. Set NEONQUANT_CRAWL_ROOT when the profile includes the layer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) is the bundle patch a profile applies. [`src/index.ts`](src/index.ts) is the package entry the path alias resolves.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [crawl group](../README.md) — the family map for this package.
- [app-boot](../../boot/app-boot/README.md) — how profiles layer bundle patches.

-----

<a id="model-experience"></a>
## Model Experience

None, as the bundle adds no model context, tools, or prompts.

#### KV Cache effect

The layer adds no request content, so an existing cache prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Shipped default profiles omit this bundle. A profile adds it, and NEONQUANT_CRAWL_ROOT enables the crawl.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
