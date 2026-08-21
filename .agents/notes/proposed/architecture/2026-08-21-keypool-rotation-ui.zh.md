# Agent Note: 密钥池轮换在凭据 UI 中只读呈现

Status: proposed

[English](2026-08-21-keypool-rotation-ui.md) | 中文

## Problem

`@deepseek-ai/dsh-credentials-keypool` 按策略把一个池引用(`QWEN_API_KEY`)解析为八个成员密钥(`QWEN_API_KEY_1..8`)之一,但每一个配置界面仍把这个池当作一把普通密钥看待。模型设置区(`packages/client/ui-settings-models`)通过 `api.credentials.describe({ refs })` 描述路由的 `apiKeyEnv: QWEN_API_KEY`,并依据返回的 `CredentialView` 渲染"API key configured"——一把只读密钥,毫无迹象表明其背后是八个可互换的成员,也看不出某个成员未配置而池仍报告已配置。池的拓扑(策略加成员引用名)只存在于 `~/.dsh/cordis.patch.yml` 中;没有任何线路字段承载它,因此任何界面都无法展示。用户从 UI 无法得知 QWEN 会轮换、存了几个成员、或哪些成员缺失。

## Proposal

通过已经抵达浏览器的凭据 seam 只读地呈现轮换状态,不新增任何可写 RPC,也不持久化任何状态。改动是凭据 describe 路径上的一个可选、无值字段,一个生产者(keypool),以及现有模型区里的通用渲染。

**Service Definition(`packages/credentials/credentials`)。** 在 `CredentialInfo` 上新增可选的 `pool?: PoolView`,其中 `PoolView = { policy: string; members: PoolMemberView[] }`,`PoolMemberView = { ref: CredentialRef; configured: boolean; source?: string }`。基类 `CredentialProvider.describe` 契约保持 `pool` 为 undefined;只有拥有轮换的 provider 才填充它。该字段无值:它携带成员引用*名*与每个成员的 `configured`/`source`,绝不携带成员值,因此遵守该 seam 现有的"读取在结构上无值"规则。它也不违反"设计上不做枚举":调用方仍需命名它早已从路由 `apiKeyEnv` 设置字段学到的那个池引用,描述这一个被命名的引用返回其形态——该 seam 不新增任何列出引用的方法。

**Provider(`packages/credentials/keypool`)。** `KeypoolCredentialProvider.describe(ref)` 对池引用返回该池的基类 describe(其 `configured`/`source` 保持已发布的"首个已配置成员"语义)加上一个 `pool` 块,后者通过 `super.describe` 描述每个成员引用构建而成。对非池引用返回原样的 `super.describe(ref)`,`pool` 保持 undefined。成员 describe 以声明的成员数为界(QWEN 为八),因此池 describe 是 O(成员数)次基类读取。

**Host RPC(`packages/host/apiproxy/src/api/credentials.ts`)。** 在 `CredentialView` 上镜像该可选块(`pool?: { policy: string; members: { ref: string; configured: boolean; source?: string }[] }`)。`describe` 方法把 `CredentialInfo.pool` 直通映射;该模块头部的无值与不枚举契约逐字延伸到该 pool 块。

**Frontend(`packages/client/ui-settings-models`)。** 当某路由 `apiKeyEnv` 的 describe 返回 `pool` 块时,`ProviderEditor` 用一个带策略标签的池徽章加每个成员一枚显示配置状态的芯片(QWEN 为八枚芯片,"N/8 configured"),替换原先单行的"API key configured"。渲染对任意池通用,仅以 `pool` 是否存在为键;它不命名任何成员引用,也不硬编码任何数量。该区已订阅 `credentials/updated`;设置或取消任一成员都会重新描述该池引用并刷新芯片,因为每次成员写入都会为该成员发出 `credentials/updated`,该区随即对被池化的引用重跑 describe。

不创建 keypool 专属客户端包:pool 块是一个只有一个生产者的通用凭据视图概念,因此模型区以渲染其他所有凭据的相同方式渲染它,线路保持 provider 中立。

## Alternatives considered

**keypool 专属客户端包(`ui-credentials-keypool`)。** 否决:它会为一个 provider 复制模型区的 describe/订阅接线,并把凭据渲染拆到两个所有者。pool 块是无值凭据状态;已经描述 `apiKeyEnv` 的通用界面才是它的自然归宿。

**暴露实时游标 / 下一个成员。** 推迟。round-robin 游标在内存中且每次启动归零;如实展示它需要 keypool 发出一个轮换事件(或 describe 读取游标),而且该展示会是尽力而为的实时位置而非持久状态。只读的成员/策略状态是有用的第一层,且无需新事件。

**交互式控制(从 UI 切换策略、pin active、重置游标)。** 推迟。它需要一个新的可写 RPC(`credentials.pools.setActive` 之类)、keypool 持久化 active 选择、以及在解析点的强制执行——一个触及持久状态、实质更大的 seam。本提案刻意止于只读,以便待读取界面验证后再单独设计写入路径。

**把 pool 块放在一个新的专用 describe 方法而非 `CredentialInfo` 上。** 否决:它会分叉每个消费者都已调用的那一条 describe 路径,并迫使模型区为一个引用调用两个方法。在现有返回上加一个可选字段可保持单一调用点。

## Acceptance criteria

- `KeypoolCredentialProvider.describe(pool)` 返回一个 `pool` 块,列出策略与每个成员及其 `configured`/`source`;非池引用的 describe 与基类 `LocalCredentialProvider.describe` 都保持 `pool` 为 undefined。
- `api.credentials.describe` 通过 `CredentialView` 承载该 `pool` 块,且有测试断言响应中绝不出现任何成员值。
- 模型设置区把 QWEN 渲染为一个池:策略 `round_robin` 与八枚反映存储状态的成员芯片;取消一个成员会在不重载的情况下更新对应芯片。
- 一个经由 `apps/web` 的无密钥快照捕获模型区中池化凭据的渲染。

## Verification

- `packages/credentials/keypool/tests/provider.spec.ts` 覆盖 describe 约定:池引用返回策略与每个成员;非池引用与基类 provider 保持 `pool` 为 undefined;并且"never places a member value in the topology"序列化 describe 结果,断言其中不出现任何成员值。
- `packages/host/apiproxy/tests/api-proxy-config.spec.ts` 断言 `credentials.describe` 无值地通过 `CredentialView` 承载该 `pool` 块。
- `packages/client/ui-settings-models/tests/components.client.spec.tsx` 把池渲染为策略徽标、`N/M configured` 计数与逐成员芯片,并断言页面上不出现任何成员值。
- `apps/web/tests/models-settings-keypool.e2e.ts` 即经由 `apps/web` 的无密钥快照:脚手架的 `keypool` 通道把随发的文件后端凭据行替换为可选装的 provider,声明一个覆盖八个成员的 `QWEN_API_KEY` 池,注入其中七个,并手工声明一个 `qwen` pi-ai 路由。金样(`snapshots/models-settings-keypool/pool.expected.md`)显示 `密钥池 轮换 7/8 已配置` 以及八枚成员芯片,且无任何成员值。

## Risks

- 为一个生产者的好处,在被每个 provider 消费的 Service Definition 上新增了一个可选字段。理由充分:池拓扑别无归宿,该字段可选且无值,且满足 seam 规则("为所有当前消费者设计"),因为该字段是通用凭据视图概念,而非 keypool 内部词汇跨越边界。
- 池 describe 对每个成员执行一次基类读取。以声明的成员数为界;无无界扇出。
- 因为不展示游标,只读状态相对于某次请求实际使用的成员可能显得陈旧。本层接受此点;推迟的游标/事件工作负责该缺口。
- 模型区的渲染必须对成员数与引用名保持通用;硬编码的"8"或 `QWEN_*` 字符串会在声明第二个池的那一刻回归。以仅按 `pool` 块内容为键的渲染加以防护。
