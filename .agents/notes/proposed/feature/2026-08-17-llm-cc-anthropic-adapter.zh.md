# Agent Note: llm-cc Claude Code anthropic-messages 适配器插件

Status: proposed

[English](2026-08-17-llm-cc-anthropic-adapter.md) | 中文

## Problem

本 harness 目前只能通过本地 agentproxy 网关驱动 `claude-opus-4-8`，而该网关只接受携带完整 Claude Code 指纹的请求。现有的 pi-ai anthropic 适配器无法生成该指纹：它的 Claude-Code 身份路径只在 `sk-ant-oat` OAuth token 上触发，即便如此也只发出一个固定的 `system[0]` 字符串，而非网关要求的计费头，且其 body 级字段不可配置。一个专用适配器插件拥有网关所接受的确切请求。

一个 PoC（`/tmp/cc-poc.mjs` 对 `127.0.0.1:9090` 上的真实代理）确立了网关接纳一个请求当且仅当以下全部满足：

- `Authorization: Bearer <token>`（绝不用 `x-api-key`）。
- 头部：`user-agent: claude-cli/<v>`、`x-app: cli`、完整的 `anthropic-beta` 列表。
- Body `system[0]` = `x-anthropic-billing-header: cc_version=<v>; cc_entrypoint=cli;`。
- Body 携带 `metadata.user_id`、`thinking:{type:adaptive}`、`context_management`、`output_config:{effort}`。

PoC 结果：纯文本 → HTTP 200，组装出 "pong"；工具调用 → HTTP 200，`get_weather({"city":"Paris"})` 经 `input_json_delta` 流式传出。请求指纹与 Anthropic-SSE→StreamChunk 转换均已证明。

## Proposal

新增 `@deepseek-ai/dsh-llm-cc`（packages/llm/llm-cc），provider 路由 `cc`。镜像 llm-deepseek 的结构；直接 fetch + SSE（不依赖 pi-ai）。

文件：

- `package.json` — peers：dsh-llm、dsh-credentials、dsh-launch-environment、dsh-settings、dsh-timeout、dsh-anonymous-user-id、dsh-invariants、cordis；deps：eventsource-parser、dsh-schemastery。
- `tsconfig.json` — 继承 base；引用那些 workspace（复制 deepseek 的）。
- `src/types.ts` — Anthropic messages 线路类型（请求 body + SSE 事件联合：message_start、content_block_start/delta/stop、message_delta、message_stop、error）。
- `src/serialize.ts` — harness GenerateOptions → Anthropic body。映射消息（user/assistant/tool-result → Anthropic content block；tool-result → user 角色 tool_result block）、tools → `input_schema`，并注入 CC 指纹：计费 `system[0]`、metadata、thinking:adaptive、context_management、由 reasoningEffort 得出的 output_config。
- `src/sse.ts` — 复用 eventsource-parser 流；Anthropic 没有 `[DONE]`，终止符是 `message_stop`。
- `src/translate.ts` — Anthropic 事件 → StreamChunk（block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish）。按 block index 有状态。
- `src/adapter.ts` — `CcAdapter extends LlmAdapter`：按请求解析 connection+key（如 DeepSeekAdapter）、idleWatchdog、带 Bearer + CC 指纹 + attributionHeaders() 的头部块、fetch、错误映射。
- `src/index.ts` — Config（apiKeyEnv=CC_API_KEY、baseURL、claudeCodeVersion、betaFeatures[]、models[]、reasoningEffort、maxTokens、streamIdleTimeoutMs、retryPolicy），apply() 含 registerConfigurableProviders + registerAdapter + installSettingsSection。
- `src/invariant.ts` — 空伴生（无独立事件流），如 deepseek。

claudeCodeVersion、betaFeatures[]、baseURL 全为 Config 字段——网关的私有策略可能变化，因此这些必须可从 cordis.yml/settings 重新配置。协议常量（anthropic-version、x-app 取值、billing-header 格式）保持固定。

组合 + 默认模型：

- 在 cordis.yml 中加入 `cc` provider，或依赖 settings.yaml（已含 `cc`）。
- 设置 ~/.dsh/settings.yaml agent-default-model → provider: cc, model: claude-opus-4-8。
- 验证：`pnpm dsh --profile headless "reply pong"` 经代理通过 opus 返回。

文档：

- packages/llm/README.md + 新包 README（按 docs/AGENTS.md 双语）。
- docs/config-catalog.md、docs/user/guide/providers.md — 增加 cc provider。
- 本 Agent Note 在合并时从 proposed 移到 implemented。

## Acceptance criteria

测试（tests/*.spec.ts，逐文件 100% 覆盖率门禁）：

- serialize.spec.ts — body 形态：计费 system[0] 存在，注入 metadata/thinking/context_management/output_config，消息+工具映射，effort 映射。
- translate.spec.ts — 每个 Anthropic 事件 → 正确的 StreamChunk；tool_use 组装；由 message_delta 得出 finish/usage。
- sse.spec.ts — 分帧、message_stop 终止。
- adapter.spec.ts / loader-composition.spec.ts / dynamic-config.spec.ts — 镜像 deepseek：注册、按请求解析、设置切换。Mock fetch/server。

网关是私有代理 → 在 CI 中不可无密钥回放；PoC 覆盖该路径。

## Risks

- SSE 转换是唯一实质性的新逻辑（Anthropic 事件不同于 OpenAI chunk）；PoC 已验证该映射。
- 网关策略是外部的；指纹漂移由 Config 字段吸收。

## Alternatives considered

- **扩展现有的 pi-ai anthropic 适配器。** 它的 Claude-Code 身份路径只在 `sk-ant-oat` OAuth token 上触发，发出一个固定的 `system[0]` 字符串而非所需的计费头，且不把 body 级字段作为 Config 暴露。把网关指纹改造进它会 fork 其身份逻辑并耦合两个不相关的 provider 面；专用适配器把确切的网关请求集中在一处。
- **复用 OpenAI-chunk 转换路径。** Anthropic messages SSE 事件（按 block 的 start/delta/stop，无 `[DONE]`，`message_stop` 终止）与 OpenAI chunk 差异足够大，共享转换器会大量分支；按 block index 有状态的转换器更清晰。
