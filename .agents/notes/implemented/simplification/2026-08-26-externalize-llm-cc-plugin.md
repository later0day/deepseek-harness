# Agent Note: Externalize the llm-cc Claude Code adapter plugin

Status: implemented

English | [中文](2026-08-26-externalize-llm-cc-plugin.zh.md)

## Problem

`@deepseek-ai/dsh-llm-cc` shipped as a first-party workspace package under `packages/llm/llm-cc/` ([the adapter design](../../proposed/feature/2026-08-17-llm-cc-anthropic-adapter.md)). It is a fork-local route to the local Claude Code gateway, not part of the harness's shipped capability set: its three introducing commits live only on `fork/master`, never on official `origin/master`. Unlike the zero-intrusion [key-pool plugin](2026-08-26-externalize-keypool-plugin.md), llm-cc was wired into the official `base` bundle — `packages/bundle/base/package.json` carried it as a `workspace:^` dependency and `cordis.patch.yml` inline-registered a `- id: llm-cc` row into every profile — so the personal `cc` route rode inside the harness's shipped composition, its build and gates, the config catalog, the composition graph, and the package README, and a future upstream sync would collide with the base-bundle edit.

## Decision

The plugin moves out of the repository to a standalone tree at `DSH/plugin/llm-cc/`, built with its own tsdown + `tsc` + vitest toolchain, and is no longer git-tracked in the harness. The package name (`@deepseek-ai/dsh-llm-cc`) is unchanged; only its location, toolchain, and mount move. Because the base bundle no longer registers it, a home overlay now must: `~/.dsh/cordis.patch.yml` inserts `- insert: [{ id: llm-cc, name: '@deepseek-ai/dsh-llm-cc' }]`, and the host resolves that name through the flat-fallback module anchor (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-cc`), the same mechanism `healProfilesModuleFallback` maintains. The `llm-cc:` section already present in `~/.dsh/settings.yaml` supplies the model catalog and key at request time exactly as before, so the route behaves identically once mounted.

The standalone package's devDependencies use `link:` to the repo's live source for all eight `@deepseek-ai/dsh-*` peers; `tsc`/`tsdown` resolve types against live `lib/types` while tsdown externalizes every `@deepseek-ai/*` and `cordis` specifier, binding runtime to the host's live instances rather than a second copy. Its two real dependencies resolve from the registry: `eventsource-parser` for Anthropic-SSE parsing and `@deepseek-ai/schemastery` pinned to `3.18.1` (the pin the key-pool externalization proved).

Removing it from the repo deletes the workspace member, the `workspace:^` line and the inline `- id: llm-cc` registration row (with its explanatory comment block) from the `base` bundle, the `tsconfig.host.json` project reference, and the EN/ZH README rows; regenerates the config catalog and the composition graph docs (the `@deepseek-ai/dsh-llm-cc` section and graph node leave the workspace). `base.spec.ts` asserts only `rows.length > 50`, still true after dropping one row, and `verify-cordis-config` stays green.

## Alternatives considered

**Keep llm-cc in the repo, externalize only keypool and the sidebar.** This was the standing fallback if the externalized adapter failed to load under peer-identity skew. llm-cc registers on `ctx.llm` — a looser adapter role than keypool's provider-on-credentials, which already proved a `link:`-typed, runtime-externalized `@deepseek-ai/*` plugin binds to the host's live seam. The `cc`-route risk gate confirmed a real Claude reply through the externalized adapter, so the fallback was not needed. It stays the documented recovery path if a future host change breaks the seam.

**Leave the base bundle registering llm-cc and only move the source.** Rejected: the base bundle is official shipped composition, so an inline row registering a fork-local adapter is exactly the coupling this change removes. Moving the registration to the home overlay keeps the personal route entirely outside the repo, matching keypool's mount.

**Publish a registry version and depend on that from the base bundle.** Rejected: the adapter is unreleased fork-local surface, so publishing it would leak it into a shared registry ahead of any upstream decision, and would still leave the base-bundle coupling in place. The home-overlay mount removes the coupling with no publish.

## Consequences

The official `base` bundle no longer ships a personal route, and a future upstream sync will not collide with the base-bundle edit. The cost is a real QA downgrade for the operator's own code: llm-cc loses harness per-file coverage, its `./invariant` gate, and its place in the assembled composition snapshots; it must be rebuilt with its own toolchain and re-mounted through the home overlay plus the flat-fallback anchor. Its `link:` devDependencies point at absolute repo paths, so moving the repo requires repointing them and re-running `pnpm install` in the standalone package. Removing the workspace member also resolves the standing `constraints` hygiene failure (`dsh-llm-cc` version must match the root version) as a side effect. Its original history remains in the harness git log; the externalized tree is unversioned for now.
