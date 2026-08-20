# dsh-credentials-keypool

[English](README.md) | 中文

轮换的[凭据](../credentials/README.md)提供方：一个池引用，多个成员键，按策略挑选。

它子类化 [`credentials-local`](../credentials-local/README.md)。*池引用*是适配器所请求的名字（例如 `QWEN_API_KEY`）；其*成员*是同一 `$DSH_HOME/.credentials.yaml` 文档中存储的具体键（例如 `QWEN_API_KEY_1` … `QWEN_API_KEY_8`）。每次解析一个池引用时，本提供方按池的策略挑选一个成员，并通过继承的文件后端解析*那个*成员。凡不是已声明池引用的一切——解析、描述、写入、热重载、销毁——都是文件提供方原样的行为。

轮换位于凭据 seam 而非某个 LLM 适配器，因为该 seam 按操作解析：在每次请求时重新读取键的适配器（直连 DeepSeek 与 pi-ai 适配器都如此）会自动看到下一个成员，无需改动适配器，也无需访问适配器私有状态。

## 配置

文件后端字段（`path`、`dshHome`、`watch`、`debounceMs`）与 [`credentials-local`](../credentials-local/README.md) 中完全一致地贯穿到底层文档，另加：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pools` | `{}` | 以适配器所请求的池引用为键的池声明。 |

每个池为 `{ policy, members, active? }`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `policy` | `round_robin` | `round_robin` 或 `manual`。 |
| `members` | — | 非空有序的成员引用列表（POSIX 标识符），每个都是文档中存储的键。 |
| `active` | 第一个成员 | `manual` 的固定成员；`round_robin` 忽略它。 |

空的 `pools` 使本提供方成为文件后端之上的直通。

<a id="policies"></a>

## 策略

- **`round_robin`** 在每次解析时推进每池的内存游标，按声明顺序遍历成员并回绕。游标每次启动都从零开始：新进程从哪个成员起步没有意义，有意义的只是相继解析会推进，所以不持久化任何东西。
- **`manual`** 始终解析固定的 `active` 成员（未固定或固定项不是成员时取第一个成员），且从不推进，因此选择权归操作者。

错误驱动的 `failover` 被刻意省去。在请求失败时推进需要 `llm/stream` 中的重试 seam，而凭据解析从不经过它；它属于会重试的消费方，而非凭据提供方。这里的轮换是负载分摊而非容错——被限流或吊销的成员在被移除前仍会按次被选中。

## 池引用不是存储槽位

池引用不映射到任何单一存储键，因此：

- `resolve(池)` 返回所选成员的值及其来源层（`env`/`file`/`project-env`/`user-env`）。
- `describe(池)` 在任一成员已配置时报告 `configured: true`——来源取第一个已配置成员——且始终 `writable: false`。
- `set(池, …)` 与 `unset(池)` 拒绝：改为存储或移除其*成员*。非池引用直通写入文档。

## 文档

成员是 [`credentials-local`](../credentials-local/README.md#the-document) 所拥有的同一 YAML 文档中的普通条目——磁盘上没有新东西：

```yaml
QWEN_API_KEY_1: sk-…
QWEN_API_KEY_2: sk-…
QWEN_API_KEY_3: sk-…
```

把 `QWEN_API_KEY` 映射到这些成员的池是组合，声明于 `pools`，而非文档条目。

## 接线

通过用户覆盖层切换凭据提供方——`$DSH_HOME` 下某 profile 的 `cordis.patch.yml`，或一个 `--patch` 文件——而非随附的 `base` bundle：池及其键是随部署而变的配置，随附默认对每个 profile 仍为 `credentials-local`。

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: credentials
  disabled: true
- insert:
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-keypool'
      config:
        pools:
          QWEN_API_KEY:
            policy: round_robin
            members:
              - QWEN_API_KEY_1
              - QWEN_API_KEY_2
              - QWEN_API_KEY_3
```

## 模型体验

间接地，通过消费的 LLM 适配器，与 [`credentials-local`](../credentials-local/README.md#model-experience) 完全一致：存储的值授权提供方请求，且适配器拥有每个模型可见面。轮换在解析出的值之上不可见。

#### KV 缓存影响

`round_robin` 在请求之间改变解析出的键，这可能把流量在按账户键控的提供方侧前缀缓存之间移动；`manual` 固定一个成员并保持该局部性。请求前缀不含凭据，因此不存在进程内的直接失效。

## 已知限制与推迟事项

- **无错误驱动的 failover**——见[策略](#policies)；坏成员在被移除前仍会按次被选中。重试层的 failover 被推迟。
- **游标仅在内存中**——重启不会恢复 round-robin 位置；只有相对推进有意义。
- 继承 [`credentials-local`](../credentials-local/README.md#known-limitations-and-deferred-work) 的每一项限制，包括同 UID 读取访问与启动时冻结的环境层。
