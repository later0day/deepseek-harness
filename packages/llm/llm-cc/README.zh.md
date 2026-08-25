# @deepseek-ai/dsh-llm-cc

[English](README.md) | 中文

harness LLM（大语言模型）seam 的 Claude Code 适配器：直接 `fetch` + SSE（Server-Sent Events，由 `eventsource-parser` 分帧），将 Anthropic messages 流式协议转换为 `StreamChunk` 协议。它经由一个只接纳携带完整 Claude Code 指纹之请求的 Claude Code 网关，驱动 `claude-opus-4-8`（以及网关所服务的任意 Claude 模型）。

网关校验一份普通 Anthropic 客户端不会发送的请求指纹：`Authorization: Bearer`（绝不用 `x-api-key`）、`claude-cli` user-agent、`x-app: cli`、`anthropic-beta` 特性列表、作为 `system[0]` 的计费头，以及 body 级的 `metadata.user_id`、`thinking:{type:adaptive}`、`context_management`、`output_config`。本包拥有 `cc` 提供方路由，并在每次请求上注入该指纹。

包根入口导出 Cordis 插件约定与 `CcAdapter`；协议序列化、SSE 解析与分片转换 helper 不属于该根约定。

## 配置

```yaml
- id: llm-cc
  name: '@deepseek-ai/dsh-llm-cc'
  config:
    apiKeyEnv: CC_API_KEY    # default; resolved per request via ctx.credentials, then the environment
    baseURL: http://127.0.0.1:9090 # optional; the local agentproxy relay when omitted
    claudeCodeVersion: 2.1.228 # fingerprint version (user-agent + billing header)
    betaFeatures:            # anthropic-beta feature list the gateway requires
      - claude-code-20250219
      - interleaved-thinking-2025-05-14
      - context-management-2025-06-27
      - effort-2025-11-24
    contextEdits:            # server-side context-management edits sent on every request
      - type: clear_thinking_20251015
        keep: all
    reasoningEffort: high    # optional; low | medium | high | xhigh | max — omitted ⇒ high
    maxTokens: 64000         # optional positive per-request output cap; this is the default
    defaultContextWindow: 200000 # optional positive-integer fallback; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses normal defaults
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    models:                  # optional; defaults to Claude Opus 4.8
      - id: claude-opus-4-8
        name: Claude Opus 4.8
        contextWindow: 200000
```

插件注册单一提供方路由 `cc` 及其解析后的 `retryPolicy`；省略即解析为 normal 默认。请求以 `provider: cc` 选择它；其 `model` 作为协议 `model` 字符串原样透传，因此更换 Claude 模型无需在生命周期时注册。省略 `models` 则通告带 200,000-token 上下文窗口的 `claude-opus-4-8`；显式列表替换该默认，而 `models: []` 一个也不通告。catalog 条目通过 `ctx.llm.listModels('cc')` 暴露给 ACP 编辑器、Web 选择器等客户端，但仅供参考：未列出的模型 id 仍原样透传。省略的条目名默认取其 id。为 `cc` 注册另一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。

`claudeCodeVersion`、`betaFeatures`、`baseURL`、`contextEdits` 是网关校验的指纹部分。它们是 Config 字段，因为网关的私有准入策略可能变化；适配器固定的协议常量（anthropic-version `2023-06-01`、`x-app: cli`、计费头格式、`thinking.type: adaptive`）不可配置。

`contextWindow` 是每个已配置模型的可选项，不经由参考性 catalog 暴露。`ctx.llm.resolveModelInfo('cc', model).context` 先返回精确的模型值，再对没有容量的条目或未列出的透传 id 返回 `defaultContextWindow`。适配器默认为 200,000；对压力敏感的插件因此获得由部署方拥有的容量，而不把模型选择器当作权威。

`maxTokens` 是适配器配置的输出上限，默认 64,000；Anthropic 要求每次请求都带一个正的 `max_tokens`。catalog 条目可携带自己的 `maxTokens`，对该模型胜出；没有的条目与任意未列出的透传 id 解析为 profile 值。精确模型解析把胜者暴露为 `defaultMaxTokens`，`LlmRuntime` 在 agent loop 写 `request/header` 之前将其物化进 `GenerateOptions.maxTokens`；显式请求或 `AgentOptions.maxTokens` 值胜出，并序列化为 `max_tokens`。

同一精确模型结果在 `reasoning` 下暴露有序的 `low`、`medium`、`high`、`xhigh`、`max` 努力档。`reasoningEffort` 选择部署默认，省略时回退 `high`。`agent/request` 可在每个会话步替换它；解析后的值记入 `request/header` 并序列化为 `output_config.effort`。harness 独有的 `off` 努力映射为网关的 `low`——网关始终思考——因此请求在协议上从不关闭思考。不支持的值在网络 I/O 之前以 `UNSUPPORTED_REASONING_EFFORT` 失败。

## 动态配置（settings + credentials）

连接事实不在 load 时冻结。`resolveAdapterOptions` 是从原始 config 到已校验事实的唯一显式解析步骤，适配器经由一个 thunk **每次操作**重读它们：base URL、catalog、指纹版本与特性、请求默认、空闲预算都在下一次请求生效，而进行中的 stream 保留其起始时的事实。三个可选 seam 供给该 thunk：

- **`ctx.settings`** —— 插件以同一份 `Config` schema 注册 `llm-cc` 命名空间，并以其 `cordis.yml` 条目作为组合 `base`，因此用户设置文档里的 `llm-cc:` 分节可以无需重启覆盖任意字段。没有挂载 settings 服务时，仅由条目 config 驱动适配器，保持不变。通过 schema 但违反 schema 之外边界（重复的 catalog id、空版本或空特性列表）的实时设置快照会保留最后一份可用事实并记录失败；条目 config 本身仍会使插件加载失败。
- **`ctx.credentials`** —— bearer token 按 stream 调用解析，来自供给端点的*同一份*解析快照，因此请求绝不会把某一代的 URL 与另一代的密钥配对。config 只携带 `apiKeyEnv`，绝不携带字面密钥：该引用经由凭据 seam 解析，没有挂载 seam 时经由受信任的 launch-environment 层解析。每个解析出的密钥在使用前都做格式校验，因此任何 HTTP 头无法承载的值都会以 `LlmError('INVALID_CREDENTIAL')` 被拒绝，并指名失败的入口点——绝不含密钥的任何部分。任何地方都没有密钥的请求以 `MISSING_CREDENTIAL` 失败，并指名 config 入口点，而路由保持注册、catalog 保持可浏览。
- **`ctx.attachments`** —— 图像请求在请求时解析该服务，因此 Cordis 加载顺序不会冻结可选的图像可用性。缺失时以 `UNSUPPORTED_CONTENT` 拒绝图像输入；纯文本调用不需要该服务。

唯一由注册捕获的事实是重试策略：当其解析值变化时，插件原地重新注册路由（同一适配器实例，一个同步小节），因此 `ctx.llm.providerRetryPolicy('cc')` 始终报告当前策略。

插件还在可配置提供方目录（`ctx.llm.listConfigurableProviders()`）中声明其路由：提供方 `cc`、显示名 `Claude Code`、设置命名空间 `llm-cc`、空设置路径——整个分节即 profile。配置界面用该条目把本适配器与其他提供方并列提供。

## 请求指纹

每次请求都携带网关准入的 Claude Code 指纹；去掉其中任何一部分都会让网关拒绝请求。头部：`Authorization: Bearer <token>`、`user-agent: claude-cli/<version> (external, cli)`、`x-app: cli`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`，以及拼接的 `anthropic-beta` 特性列表。Body：`system[0]` 是计费头 `x-anthropic-billing-header: cc_version=<version>; cc_entrypoint=cli;`（harness 系统提示词随后作为 `system[1]`），外加 `metadata.user_id`、`thinking:{type:adaptive}`、`context_management.edits` 与 `output_config.effort`。`metadata.user_id` 是由 [`@deepseek-ai/dsh-anonymous-user-id`](../../identity/anonymous-user-id/README.zh.md) 的稳定匿名 id 构建的 JSON 对象；指纹拥有 `user-agent`，因此本路由刻意不发送 harness 归因基线。

## 协议格式说明

- 仅流式。usage 跨 `message_start`（输入 + cache 读）与 `message_delta`（输出 + cache 写）累积；translator 把两者都推迟到 `message_stop`，因此 `usage` 始终先于 `finish`。
- 没有 `[DONE]` 哨兵：终止事件是 `message_stop`。在其之前 EOF 抛出 `STREAM_CLOSED`。
- 每个 Anthropic 内容块 index 对应一个 harness 块：`text` → text、`thinking` → reasoning、`tool_use` → tool-call。`tool_use` 在块打开时携带其 id 与 name，绝不在后续 delta 中；`input_json_delta` 流式传出参数字符串。
- `signature_delta` 不含 harness 可见内容，被丢弃。
- cache 记账把 `cache_read_input_tokens` → `cacheReadTokens`、`cache_creation_input_tokens` → `cacheWriteTokens`；Anthropic 报告的 `input_tokens` 已与 cache 不相交。
- harness tool-result 与 image 块搭乘 user 角色消息，成为 Anthropic user 角色的 `tool_result` 与 `image` 块；空工具输出以字面量 `(no output)` 过线。assistant `tool-call` 参数从原始字符串解析为 JSON `input`。

## 错误

非 2xx 响应抛出带稳定码的 `LlmError`：`AUTH`（401/403）、`QUOTA`（provider 细节标明配额、余额或额度耗尽的响应）、`RATE_LIMIT`（其余 429）、`CONTEXT_WINDOW_EXCEEDED`（provider type 或 message 标明上下文溢出的 400）、`INVALID_REQUEST`（其余 400）、`SERVER`（5xx），其余为 `HTTP_<status>`。其可序列化的 `failure` 保留 HTTP 状态，外加有效的正 `retry-after` 秒数/日期延迟，以及存在时的 `request-id` / `x-request-id`；网关的错误消息成为主文本，格式错误的错误 JSON 绝不遮蔽状态。响应前的传输失败（DNS、拒绝连接、TLS、代理）抛出 `TRANSPORT` 并指名已配置端点、把原始拒绝链为 `cause`；调用方中止抛出 `ABORTED`，每次读取的空闲看门狗在 `streamIdleTimeoutMs` 后抛出 `TIMEOUT`。协议违规抛出 `STREAM_CLOSED`（无 `message_stop`）、`MALFORMED_RESPONSE`（错误 JSON 载荷）或 `PROVIDER_ERROR`（流 `error` 事件）。未知的协议 `stop_reason` 成为 `finish {kind: 'error', failure}` 分片，而一个 `end_turn`（或缺省）完成却未打开任何内容块的完整 stream 成为码为 `EMPTY_RESPONSE` 的 `finish {kind: 'error'}`。无 body 的网关响应抛出 `EMPTY_RESPONSE`。没有附件服务的图像输入抛出 `UNSUPPORTED_CONTENT`。

## 模型体验

### Claude Code 请求

#### 模型看到的内容

选定的 Claude 模型收到计费 `system[0]` 头，随后是 harness 系统提示词、消息历史、工具 schema、停止序列与调用配置。保留的 user 与 tool-result 图像作为从耐久附件存储解析出的 base64 `image` 块发送；带图像却无附件服务的请求在过线前被拒绝。网关要求的 `thinking:adaptive`、`context_management` 与 `output_config.effort` 伴随每次请求。

#### Token 影响

provider 分词决定精确的文本与图像 token 输入。计费 `system[0]` 头与服务端 `context_management` 编辑每次请求恒定；网关返回时报告 cache 读用量。

#### KV Cache 影响

未变的已组装前缀——固定的计费头、系统提示词与历史——有资格被网关 cache 复用，本适配器将其报告为 `cacheReadTokens`。模型路由变化，或任何上游提示词、schema、前缀、历史、指纹版本或图像变化，都可能从第一个变化的 token 起阻止复用。

### Claude Code 响应

#### 模型看到的内容

思考、文本与工具调用参数以 Anthropic 内容块 delta 流出，并被转换为 harness 分片供 loop 记录与组装；`thinking` 块成为 reasoning 块。

#### Token 影响

生成 token 遵循请求已记录的推理努力与 `maxTokens`；只有 loop 保留的块影响后续输入。网关返回时报告 cache 写用量。

#### KV Cache 影响

loop 保留的响应块追加到下一次请求并保住其较早的可复用前缀；被丢弃的块无后续 cache 影响。更换提供方或模型会选择不同的 cache 域。

## 已知限制与暂缓事项

- **网关是私有代理** —— 其请求路径在 CI 中不可无密钥回放；一个针对实时中继的 PoC 覆盖它，单元测试 mock `fetch` 与 SSE 流。
- **请求用裸 `fetch`，而非 `@cordisjs/plugin-http`** —— 没有共享的代理/拦截配置；采纳推迟到第二个适配器需要它时（`TODO(http)`）。
- **harness 独有的 `off` 努力无法关闭思考** —— 网关始终思考，因此 `off` 映射为 `low`；部署无法在本路由上关掉推理。
- **图像是仅输入的 base64 附件** —— 不支持直接外部 URL 与 assistant 图像输出，也没有 Files API 卸载，因此庞大的图像历史每次请求都内联发送。
- **settings 的 `models` 列表整体替换组合列表** —— settings 层合并是按字段的，而数组是一个字段；按条目的 catalog 合并需要一个带键的结构。
