# Agent Note: Externalize the key-pool credential plugin

Status: implemented

English | [中文](2026-08-26-externalize-keypool-plugin.zh.md)

## Problem

`@deepseek-ai/dsh-credentials-keypool` shipped as a first-party workspace package under `packages/credentials/keypool/` ([the rotation decision](../feature/2026-08-21-credentials-keypool-rotation.md)). It is a fork-local operator convenience, not part of the harness's shipped capability set: no first-party consumer depends on it, and it exists to spread one operator's interchangeable keys across requests. Keeping it in the workspace coupled a personal add-on to the harness's build, coverage, invariant, and e2e gates — every repo-wide gate ran against it, a committed `apps/web` e2e lane and snapshot exercised it, and the config catalog and package READMEs listed it — so unrelated harness work carried its weight and a future upstream sync would collide with it.

## Decision

The plugin moves out of the repository to a standalone tree at `DSH/plugin/keypool/`, built with its own tsdown + `tsc` + vitest toolchain, and is no longer git-tracked in the harness. The package name (`@deepseek-ai/dsh-credentials-keypool`) and its keypool-style `insert`-by-name mount are unchanged; only its location and toolchain move. At runtime the host harness resolves the plugin name through the flat-fallback module anchor (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-credentials-keypool`), the same mechanism `scaffold.ts` created by hand and `healProfilesModuleFallback` maintains, so the existing home overlay loads it for every profile with no overlay edit.

Its build-time peer types (`PoolView`, `PoolMemberView`, `CredentialInfo.pool`) exist only in this fork's live source, not in any published registry version, so the standalone package's devDependencies use `link:` to the repo's live `credentials`, `credentials-local`, and `invariants` packages; `tsc`/`tsdown` resolve types against live `lib/types` while tsdown externalizes every `@deepseek-ai/*` and `cordis` specifier, binding runtime to the host's live instances rather than a second copy.

Removing it from the repo deletes the workspace member, the `apps/web` keypool e2e lane and its snapshot, the `scaffold.ts` keypool wiring, the tsconfig references, and the EN/ZH README rows; regenerates the config catalog and the `tool-cordis` API catalog (the `Pick` type from `keypool/src/pick.ts` leaves the workspace type graph); and drops the `verify-package-readme-model-experience` allowlist entry. The rotation design itself is unchanged and still documented by [the rotation note](../feature/2026-08-21-credentials-keypool-rotation.md), which now describes an externally-shipped plugin.

## Alternatives considered

**Keep keypool in the repo, externalize only the sidebar.** This was the standing fallback if the externalized plugin failed to load under peer-identity skew — the credentials seam is tighter than sidebar's loose `ctx` consumer because keypool registers a provider on it. The build and a live resolve confirmed the `link:`-typed, runtime-externalized package binds to the host seam correctly, so the fallback was not needed. It stays the documented recovery path if a future host change breaks the seam.

**Publish a registry version carrying the pool types and depend on that.** Rejected: the pool types live only in this unreleased fork, so publishing them would leak fork-local surface into a shared registry ahead of any upstream decision, and would still not remove keypool's weight from the repo's gates. `link:` against live source gives the standalone package correct types with no publish.

**Vendor a copy of the pool types into the keypool package.** Rejected: a hand-copied type declaration drifts from the live `credentials` source it must match, and the harness's own gates that would have caught the drift no longer run against the externalized tree. `link:` keeps one authoritative type source.

## Consequences

The harness build, coverage, invariant, and e2e gates no longer carry a personal add-on, and a future upstream sync will not collide with it. The cost is a real QA downgrade for the operator's own code: keypool loses harness per-file coverage, its `./invariant` gate, and the committed e2e lane and snapshot; it must be rebuilt with its own toolchain and re-mounted through the flat-fallback anchor. Its `link:` devDependencies point at absolute repo paths, so moving the repo requires repointing them and re-running `pnpm install` in the standalone package. Its original history remains in the harness git log; the externalized tree is unversioned for now.
