/**
 * Translate Anthropic messages SSE events into the harness `StreamChunk`
 * protocol. One harness block per Anthropic content-block index: `text` →
 * text, `thinking` → reasoning, `tool_use` → tool-call. Deltas stream as they
 * arrive; `block-end` is emitted on `content_block_stop`. The finish reason and
 * usage are deferred to `message_delta`, and the stream terminates on
 * `message_stop`. EOF before `message_stop` is a truncated response.
 *
 * @module dsh-llm-cc/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WireEvent, WireUsage } from './types.ts'

/**
 * One open block under assembly, discriminated on `kind`. A `tool-call` block
 * always carries the `callId` and `name` from its `content_block_start`
 * (Anthropic sends both at block open, never in later deltas), so no downstream
 * step guesses them.
 */
type OpenBlock =
  | { kind: 'text' | 'reasoning'; text: string }
  | { kind: 'tool-call'; text: string; callId: string; name: string }

/**
 * Map the Anthropic stop_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `stop_reason` string, or null/undefined.
 * @returns the mapped reason; unrecognized values become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case null:
    case undefined:
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields to disjoint harness counts. Anthropic already reports
 * disjoint values: `input_tokens` excludes cache, reported separately.
 * @param usage - wire usage from a `message_start` or `message_delta` event.
 * @returns disjoint harness counts; cache fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...usage.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {},
    ...usage.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId),
      name: block.name,
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads and yield StreamChunks. Malformed JSON payloads
 * abort the stream with `MALFORMED_RESPONSE`; an `error` event aborts with
 * `PROVIDER_ERROR`. EOF before `message_stop` aborts with `STREAM_CLOSED`.
 * @param payloads - SSE data payloads from {@link parseSse}.
 * @returns deltas as they arrive; `usage` and `finish` are deferred to `message_delta`/`message_stop`.
 *   A `stop` finish with no opened blocks maps to an `EMPTY_RESPONSE` error finish.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, OpenBlock>()
  let openedCount = 0
  let pendingFinish: FinishReason | undefined
  // Accumulate raw wire usage across message_start (input + cache reads) and
  // message_delta (output + cache writes): a parsed payload omits absent keys,
  // so object-spread is a clean field union that never clobbers a prior count
  // with a defaulted zero. Mapped to disjoint harness counts once, at emit.
  let pendingUsage: WireUsage | undefined

  for await (const payload of payloads) {
    let event: WireEvent
    try {
      event = JSON.parse(payload) as WireEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    switch (event.type) {
      case 'message_start':
        if (event.message.usage) pendingUsage = { ...pendingUsage, ...event.message.usage }
        break

      case 'content_block_start': {
        const cb = event.content_block
        if (cb.type === 'tool_use') {
          blocks.set(event.index, { kind: 'tool-call', text: '', callId: cb.id, name: cb.name })
          openedCount++
          yield { type: 'block-start', index: event.index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: event.index,
            id: CallId(cb.id),
            name: cb.name,
            argumentsDelta: '',
          }
          break
        }
        const kind = cb.type === 'thinking' ? 'reasoning' : 'text'
        blocks.set(event.index, { kind, text: '' })
        openedCount++
        yield { type: 'block-start', index: event.index, blockType: kind }
        break
      }

      case 'content_block_delta': {
        const block = blocks.get(event.index)
        if (block === undefined) break
        const d = event.delta
        if (d.type === 'text_delta') {
          block.text += d.text
          yield { type: 'text-delta', index: event.index, text: d.text }
        } else if (d.type === 'thinking_delta') {
          block.text += d.thinking
          yield { type: 'reasoning-delta', index: event.index, text: d.thinking }
        } else if (d.type === 'input_json_delta') {
          block.text += d.partial_json
          const tool = block.kind === 'tool-call' ? block : undefined
          yield {
            type: 'tool-call-delta',
            index: event.index,
            id: CallId(tool?.callId ?? ''),
            ...tool !== undefined ? { name: tool.name } : {},
            argumentsDelta: d.partial_json,
          }
        }
        // signature_delta carries no harness-visible content.
        break
      }

      case 'content_block_stop': {
        const block = blocks.get(event.index)
        if (block !== undefined) {
          yield { type: 'block-end', index: event.index, block: closeBlock(block) }
        }
        break
      }

      case 'message_delta':
        if (event.usage) pendingUsage = { ...pendingUsage, ...event.usage }
        pendingFinish = mapStopReason(event.delta.stop_reason)
        break

      case 'message_stop': {
        if (pendingUsage) yield { type: 'usage', usage: mapUsage(pendingUsage) }
        const reason = pendingFinish ?? { kind: 'stop' as const }
        yield {
          type: 'finish',
          reason: reason.kind === 'stop' && openedCount === 0
            ? {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            }
            : reason,
        }
        return
      }

      case 'error':
        throw new LlmError(
          `Claude Code stream error: ${event.error?.message ?? event.error?.type ?? 'unknown'}`,
          'PROVIDER_ERROR',
        )

      case 'ping':
        break
    }
  }

  throw new LlmError('SSE stream ended without message_stop', 'STREAM_CLOSED')
}
