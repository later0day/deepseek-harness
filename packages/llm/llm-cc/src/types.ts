/**
 * Anthropic messages wire format, as accepted by the Claude Code gateway. Types
 * only.
 *
 * Source of truth: the Anthropic Messages streaming API, cross-checked against
 * live Claude Code requests captured from the local agentproxy gateway
 * (2026-08). Every request must carry the Claude Code fingerprint the gateway
 * admits (see {@link WireRequest}); {@link ../serialize} builds it.
 *
 * @module dsh-llm-cc/types
 */

/**
 * Request body for `POST {baseURL}/v1/messages?beta=true`. Always streaming.
 * The gateway admits a request only when it carries the full Claude Code
 * fingerprint: `system[0]` is the billing header, and `metadata`, `thinking`,
 * `context_management`, and `output_config` are all present.
 */
export interface WireRequest {
  model: string
  /** System blocks; `system[0]` MUST be the billing header for gateway admission. */
  system: WireSystemBlock[]
  messages: WireMessage[]
  max_tokens: number
  stream: true
  tools?: WireTool[]
  /** Adaptive thinking toggle; the gateway requires its presence. */
  thinking: { type: 'adaptive' }
  /** Server-side thinking-context maintenance; required by the gateway. */
  context_management: { edits: WireContextEdit[] }
  /** Reasoning effort; required by the gateway. */
  output_config: { effort: 'high' | 'max' | 'medium' | 'low' | 'xhigh' }
  /** Opaque client attribution the gateway records. */
  metadata: { user_id: string }
  temperature?: number
  /** Stop sequences: generation halts on any one of these strings. */
  stop_sequences?: string[]
}

/** One server-side context-management edit. */
export interface WireContextEdit {
  /** Edit strategy the gateway applies to prior turns (for example `clear_thinking_20251015`). */
  type: string
  /** Which content the edit retains (for example `all`). */
  keep: string
}

/** One system block: a single text span. */
export interface WireSystemBlock {
  type: 'text'
  text: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export interface WireMessage {
  role: 'user' | 'assistant'
  content: WireContentBlock[]
}

/** A content block on a request message. */
export type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/** One entry of the request `tools` array; `input_schema` is a JSON Schema object. */
export interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * One parsed SSE event, discriminated on `type`. The Anthropic stream opens
 * with `message_start`, interleaves `content_block_*` per block index, and ends
 * with `message_delta` (carrying stop reason and usage) then `message_stop`.
 */
export type WireEvent =
  | { type: 'message_start'; message: { usage?: WireUsage } }
  | { type: 'content_block_start'; index: number; content_block: WireStreamBlock }
  | { type: 'content_block_delta'; index: number; delta: WireDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string | null }; usage?: WireUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { type?: string; message?: string } }

/** The block descriptor on a `content_block_start` event. */
export type WireStreamBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id: string; name: string }

/** The incremental content on a `content_block_delta` event. */
export type WireDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string }

/**
 * Wire token accounting. Anthropic reports disjoint counts already:
 * `input_tokens` excludes cache, with cache reads/writes reported separately.
 */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string }
}
