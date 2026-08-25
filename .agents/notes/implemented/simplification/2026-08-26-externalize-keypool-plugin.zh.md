# Agent Note: 将 key-pool 凭据插件外置

Status: implemented

[English](2026-08-26-externalize-keypool-plugin.md) | 中文

## Problem

`@deepseek-ai/dsh-credentials-keypool` 曾作为第一方工作区包位于 `packages/credentials/keypool/`（[轮换决策](../feature/2026-08-21-credentials-keypool-rotation.zh.md)）。它是本 fork 本地的运维便利工具，并非 harness 出货能力集的一部分：没有任何第一方消费方依赖它，它的存在只是为了把某位运维者手中可互换的多把密钥分摊到各请求上。把它留在工作区，就是把一个私人附加件耦合进了 harness 的构建、覆盖率、invariant 与 e2e 各道闸——每一道仓库级闸门都会对它运行，一条已提交的 `apps/web` e2e 通道及其快照会驱动它，配置目录与包 README 都列出它——于是无关的 harness 工作都要为它承重，且未来的上游同步会与它冲突。

## Decision

该插件迁出仓库，成为 `DSH/plugin/keypool/` 下的独立目录树，用它自己的 tsdown + `tsc` + vitest 工具链构建，不再纳入 harness 的 git 跟踪。包名（`@deepseek-ai/dsh-credentials-keypool`）及其 keypool 风格的按名 `insert` 挂载方式均不变；变的只是位置与工具链。运行时，宿主 harness 通过扁平回退模块锚点（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-credentials-keypool`）解析该插件名——正是 `scaffold.ts` 曾手工创建、`healProfilesModuleFallback` 负责维护的那套机制——因此既有的 home 覆盖层无需改动即可为每个 profile 加载它。

它的构建期 peer 类型（`PoolView`、`PoolMemberView`、`CredentialInfo.pool`）只存在于本 fork 的实时源码里，任何已发布的注册表版本中都没有，所以独立包的 devDependencies 用 `link:` 指向仓库中实时的 `credentials`、`credentials-local`、`invariants` 包；`tsc`/`tsdown` 对着实时的 `lib/types` 解析类型，同时 tsdown 把每一个 `@deepseek-ai/*` 与 `cordis` 说明符都外部化，使运行时绑定到宿主的实时实例而非第二份副本。

从仓库中移除它，会删除该工作区成员、`apps/web` 的 keypool e2e 通道及其快照、`scaffold.ts` 中的 keypool 接线、tsconfig 引用，以及 EN/ZH README 的行；并重新生成配置目录与 `tool-cordis` API 目录（来自 `keypool/src/pick.ts` 的 `Pick` 类型离开工作区类型图）；同时移除 `verify-package-readme-model-experience` 的允许列表条目。轮换设计本身不变，仍由[轮换 note](../feature/2026-08-21-credentials-keypool-rotation.zh.md) 记录，只是它现在描述的是一个外部出货的插件。

## Alternatives considered

**把 keypool 留在仓库，只外置 sidebar。** 这是外置插件在 peer 身份错位下加载失败时的既定回退方案——凭据 seam 比 sidebar 松散的 `ctx` 消费方更紧，因为 keypool 在其上注册了一个 provider。构建与一次实时解析确认了 `link:` 定型、运行时外部化的包能正确绑定到宿主 seam，故未动用该回退。若未来宿主改动破坏了该 seam，它仍是有记录的恢复路径。

**发布一个携带 pool 类型的注册表版本并依赖之。** 否决：pool 类型只存在于这个未发布的 fork 中，发布它们会在任何上游决定之前把 fork 本地的表面泄漏进共享注册表，且仍无法把 keypool 的负重从仓库各道闸门上卸下。对着实时源码用 `link:` 无需发布即可给独立包正确的类型。

**把 pool 类型的副本 vendored 进 keypool 包。** 否决：手工复制的类型声明会与它必须匹配的实时 `credentials` 源码漂移，而本可捕获该漂移的 harness 自有闸门已不再对外置树运行。`link:` 保持单一权威类型来源。

## Consequences

harness 的构建、覆盖率、invariant 与 e2e 各道闸门不再为一个私人附加件承重，未来的上游同步也不会与之冲突。代价是对运维者自己这份代码的一次实打实的 QA 降级：keypool 失去了 harness 的按文件覆盖率、它的 `./invariant` 闸门，以及那条已提交的 e2e 通道与快照；它必须用自己的工具链重建，并经由扁平回退锚点重新挂载。它的 `link:` devDependencies 指向绝对仓库路径，因此移动仓库需要重新指向它们并在独立包中重跑 `pnpm install`。它的原始历史仍留在 harness 的 git 日志中；外置树目前不纳入版本控制。
