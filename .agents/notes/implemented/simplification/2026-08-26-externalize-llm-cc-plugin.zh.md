# Agent Note: 将 llm-cc Claude Code 适配器插件外置

Status: implemented

[English](2026-08-26-externalize-llm-cc-plugin.md) | 中文

## Problem

`@deepseek-ai/dsh-llm-cc` 曾作为第一方工作区包位于 `packages/llm/llm-cc/`（[适配器设计](../../proposed/feature/2026-08-17-llm-cc-anthropic-adapter.zh.md)）。它是本 fork 本地通往本地 Claude Code 网关的一条路由，并非 harness 出货能力集的一部分：引入它的三个提交只存在于 `fork/master`，官方 `origin/master` 上从未有过。与零侵入的 [key-pool 插件](2026-08-26-externalize-keypool-plugin.zh.md) 不同，llm-cc 被接进了官方 `base` bundle——`packages/bundle/base/package.json` 以 `workspace:^` 依赖携带它，`cordis.patch.yml` 又把一行 `- id: llm-cc` 内联注册进每个 profile——于是这条私人 `cc` 路由就搭乘在 harness 的出货组合、其构建与各道闸门、配置目录、组合图与包 README 之内，且未来的上游同步会与这处 base-bundle 改动冲突。

## Decision

该插件迁出仓库，成为 `DSH/plugin/llm-cc/` 下的独立目录树，用它自己的 tsdown + `tsc` + vitest 工具链构建，不再纳入 harness 的 git 跟踪。包名（`@deepseek-ai/dsh-llm-cc`）不变；变的只是位置、工具链与挂载方式。因为 base bundle 不再注册它，现在必须由一个 home 覆盖层来做：`~/.dsh/cordis.patch.yml` 插入 `- insert: [{ id: llm-cc, name: '@deepseek-ai/dsh-llm-cc' }]`，宿主再通过扁平回退模块锚点（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-cc`）解析该名——正是 `healProfilesModuleFallback` 负责维护的那套机制。`~/.dsh/settings.yaml` 中既有的 `llm-cc:` 段仍在请求时提供模型目录与密钥，与此前完全一致，因此一经挂载，该路由的行为不变。

独立包的 devDependencies 对全部八个 `@deepseek-ai/dsh-*` peer 用 `link:` 指向仓库中的实时源码；`tsc`/`tsdown` 对着实时的 `lib/types` 解析类型，同时 tsdown 把每一个 `@deepseek-ai/*` 与 `cordis` 说明符都外部化，使运行时绑定到宿主的实时实例而非第二份副本。它的两个真实依赖从注册表解析：用于 Anthropic-SSE 解析的 `eventsource-parser`，以及固定到 `3.18.1` 的 `@deepseek-ai/schemastery`（key-pool 外置已验证的那个 pin）。

从仓库中移除它，会删除该工作区成员、`base` bundle 中的 `workspace:^` 行与内联的 `- id: llm-cc` 注册行（连同其解释性注释块）、`tsconfig.host.json` 的项目引用，以及 EN/ZH README 的行；并重新生成配置目录与组合图文档（`@deepseek-ai/dsh-llm-cc` 段与图节点离开工作区）。`base.spec.ts` 只断言 `rows.length > 50`，去掉一行后仍成立，`verify-cordis-config` 也保持通过。

## Alternatives considered

**把 llm-cc 留在仓库，只外置 keypool 与 sidebar。** 这是外置适配器在 peer 身份错位下加载失败时的既定回退方案。llm-cc 注册在 `ctx.llm` 上——一个比 keypool 的 provider-on-credentials 更松散的适配器角色，而 keypool 已证明 `link:` 定型、运行时外部化的 `@deepseek-ai/*` 插件能绑定到宿主的实时 seam。`cc` 路由风险闸确认了经外置适配器返回真实 Claude 回复，故未动用该回退。若未来宿主改动破坏了该 seam，它仍是有记录的恢复路径。

**让 base bundle 继续注册 llm-cc，只搬源码。** 否决：base bundle 是官方出货组合，一行注册 fork 本地适配器的内联行正是本次变更要移除的耦合。把注册移到 home 覆盖层，可把这条私人路由完全置于仓库之外，与 keypool 的挂载方式一致。

**发布一个注册表版本并让 base bundle 依赖之。** 否决：该适配器是未发布的 fork 本地表面，发布它会在任何上游决定之前把它泄漏进共享注册表，且仍会保留 base-bundle 的耦合。home 覆盖层挂载无需发布即可移除耦合。

## Consequences

官方 `base` bundle 不再出货一条私人路由，未来的上游同步也不会与这处 base-bundle 改动冲突。代价是对运维者自己这份代码的一次实打实的 QA 降级：llm-cc 失去了 harness 的按文件覆盖率、它的 `./invariant` 闸门，以及它在组合快照中的位置；它必须用自己的工具链重建，并经由 home 覆盖层加扁平回退锚点重新挂载。它的 `link:` devDependencies 指向绝对仓库路径，因此移动仓库需要重新指向它们并在独立包中重跑 `pnpm install`。移除该工作区成员还顺带解决了长期存在的 `constraints` hygiene 失败（`dsh-llm-cc` 版本须与根版本一致）。它的原始历史仍留在 harness 的 git 日志中；外置树目前不纳入版本控制。
