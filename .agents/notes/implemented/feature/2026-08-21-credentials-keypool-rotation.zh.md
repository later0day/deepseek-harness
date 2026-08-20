# Agent Note: Key-pool credential rotation

Status: implemented

[English](2026-08-21-credentials-keypool-rotation.md) | 中文

## Problem

一个为同一提供方持有多把可互换 API 键的操作者——被切分到多个账户的限速套餐、一批网关键——无法把请求分摊到它们之间。`credentials` seam 把一个引用解析为一个值，而每个适配器只请求单一引用（`QWEN_API_KEY`、`DEEPSEEK_API_KEY`），因此在手工编辑之前，所有流量都用同一把键认证。第三方 dockyard-dsh 插件的做法是猴补丁私有的 `llm.adapters` 映射以包装每个适配器的 `resolveApiKey`，这伸入了没有任何公开接口暴露的适配器内部字段，无法通过本仓库的门禁。

## Decision

`@deepseek-ai/dsh-credentials-keypool` 改为在凭据 seam 加入轮换，而非适配器。它是一个子类化文件后端 `LocalCredentialProvider` 的 `KeypoolCredentialProvider`：一个*池引用*（适配器所请求的名字，如 `QWEN_API_KEY`）映射到一个有序的*成员引用*列表（具体存储的键，如 `QWEN_API_KEY_1` … `QWEN_API_KEY_8`），它们都存在同一 `$DSH_HOME/.credentials.yaml` 文档中。每次 `resolve` 一个池引用时，本提供方按池的策略挑选一个成员并委托给 `super.resolve(成员)`；凡未声明为池的引用以及一切存储，都是文件后端原样的行为。

轮换位于凭据 seam，是因为该 seam 按操作解析：直连 DeepSeek 适配器（`llm-deepseek/src/index.ts`）与 pi-ai 适配器（`llm-pi-ai/src/index.ts`）都在每次请求时调用 `credentials.resolve(ref)`，因此一个轮换的提供方就能为每个适配器把键分摊到各请求，无需改动适配器，也无需访问适配器私有状态。

随附两个策略。`round_robin` 在每次解析时推进每池的内存游标，按声明顺序遍历成员并回绕；游标每次启动都从零开始，因为新进程从哪个成员起步没有意义，有意义的只是相继解析会推进。`manual` 始终解析固定的 `active` 成员（未固定时取第一个成员），因此选择权归操作者。错误驱动的 `failover` 被刻意省去：在请求失败时推进需要 `llm/stream` 中的重试 seam，而这条解析路径从不经过它。

池引用不映射到任何单一存储槽位，因此 `describe` 在任一成员已配置时报告其已配置（来源取第一个已配置成员）且从不可写，而 `set`/`unset` 拒绝它并给出指向其成员的提示。池声明是经校验的 `Config`（`pools`，一个池引用到 `{policy, members, active?}` 的映射），因此本包不随附任何硬编码的池；空映射使本提供方成为文件后端之上的直通。

把一个池接入运行中的 harness 是用户覆盖层的事，而非改动随附的 `base` bundle：`$DSH_HOME` 下某 profile 的 `cordis.patch.yml`（或一个 `--patch` 文件）禁用默认 `credentials` 行，并插入一行绑定到本包并带上操作者的池。随附默认对每个 profile 仍为 `credentials-local`，而随部署而变的池组合及其成员键只存在于未被追踪的 harness home 里。

## Alternatives considered

- **猴补丁 `llm.adapters`（dockyard 的做法）。** `llm.adapters` 是没有公开取值器的私有映射，适配器 `config` 也是适配器内部的；包装 `resolveApiKey` 需要 `(llm as any)` 强转伸入私有字段，会被类型与 hygiene 门禁拒绝。它还要为每种适配器重复包装。seam 层的提供方通过单一公开接口触达每个适配器。
- **在 `llm/stream` 上新增一个 LLM 插件里轮换。** 对*错误驱动的* failover 而言这是对的层——它能看到请求结果——但对负载分摊而言是错的：它会重新实现凭据 seam 已经解析的按请求键选择，且无法服务非 LLM 的凭据消费方。若将来构建它，failover 留给那一层。
- **在隔离作用域组合一个单独的基础提供方并委托给它。** cordis 服务是单槽位的，`provide` 在重复注册 `credentials` 时抛错，因此一个委托式提供方需要一个在本代码库里没有先例的 `ctx.isolate` 包装。子类化以小得多的耦合面，通过基础提供方的公开与受保护面复用其文件锁、分层、热重载与销毁。
- **把池烘焙进随附的 `base` bundle。** 池及其键是随部署而变的配置；把它们硬编码进产品树违反“插件中无硬编码可调项”的规则，且会改变每个 profile 与每个快照的 `credentials` 提供方。用户覆盖层让默认保持不动。

## Testing

包单元测试固定了纯选择（`round_robin` 顺序与回绕、`manual` 固定与首成员回退、闭合联合的穷尽性）、配置 schema（策略默认、成员打标、空成员与空池拒绝），以及在临时文档之上的提供方（八键轮换序列、manual 固定、非池与空池直通、聚合 `describe`、以及对池引用的 `set`/`unset` 拒绝）。逐文件覆盖率为 100%。

## Consequences

操作者把一个提供方的流量分摊到多把键，只需把它们列为池成员并通过用户覆盖层切换凭据提供方——没有适配器、会话格式或 SDK 的改动，因为轮换在解析出的值之上不可见。游标仅在内存中，因此重启不会恢复 round-robin 位置；这是有意为之，因为只有相对推进有意义。轮换是负载分摊而非韧性：被限流或吊销的成员在操作者移除它之前仍会按次被选中，因为错误驱动的 failover 属于本包并不添加的重试层。
