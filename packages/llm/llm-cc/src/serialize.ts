/**
 * Serialize harness messages into an Anthropic messages request carrying the
 * Claude Code fingerprint the gateway admits. User/assistant text, images, and
 * tool calls become Anthropic content blocks; harness tool-result messages
 * become user-role `tool_result` blocks. The fingerprint — billing `system[0]`,
 * `metadata`, `thinking:adaptive`, `context_management`, `output_config` — is
 * injected here, since the gateway rejects any request missing it.
 * @module dsh-llm-cc/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type {
  WireContentBlock,
  WireContextEdit,
  WireMessage,
  WireRequest,
  WireSystemBlock,
  WireTool,
} from './types.ts'

/** Gateway-admission effort levels for `output_config`. */
export type WireEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Adapter-level request defaults (from plugin config). These fill the Claude
 * Code fingerprint the gateway checks; they are deployment-varying because the
 * gateway's private admission policy may change.
 */
export interface RequestDefaults {
  /** Claude Code version stamped into the billing `system[0]` header. */
  claudeCodeVersion: string
  /** Opaque client attribution replayed as `metadata.user_id`. */
  userId: string
  /** Server-side context-management edits sent on every request. */
  contextEdits: WireContextEdit[]
  /** Effort used when the request selects none. */
  defaultEffort: WireEffort
  /** Per-request output cap when the request sets none; Anthropic requires a positive `max_tokens`. */
  maxTokens: number
}

/**
 * Pre-resolved image data for one attachment ref. The adapter resolves images
 * from the durable {@link AttachmentStore} before serialization so this module
 * stays a pure synchronous function.
 */
export interface ResolvedImage {
  /** MIME type verified from the stored bytes. */
  mediaType: string
  /** Base64-encoded image data. */
  data: string
}

/**
 * The billing header the gateway requires as `system[0]`. Format is fixed by
 * the gateway; only the version is substituted.
 * @param version - the configured Claude Code version.
 * @returns the billing header text.
 */
export function billingHeaderText(version: string): string {
  return `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli;`
}

/** Map the harness reasoning effort to a gateway effort level. */
function resolveEffort(
  effort: GenerateOptions['reasoningEffort'],
  fallback: WireEffort,
): WireEffort {
  if (effort === undefined) return fallback
  switch (effort as string) {
    case 'off': return 'low'
    case 'low': return 'low'
    case 'medium': return 'medium'
    case 'high': return 'high'
    case 'xhigh': return 'xhigh'
    case 'max': return 'max'
    default:
      throw new LlmError(
        `Claude Code adapter does not support reasoning effort "${String(effort)}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
  }
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Serialize user-role content blocks, resolving images from the pre-built map.
 * Text blocks are flattened into a single block (Anthropic merges them anyway);
 * images and tool-results are emitted as individual typed blocks.
 * @param blocks - harness content blocks from one user message.
 * @param images - pre-resolved image bytes keyed by attachment id; undefined when the request has no images.
 */
function serializeUserBlocks(
  blocks: readonly ContentBlock[],
  images: ReadonlyMap<string, ResolvedImage> | undefined,
): WireContentBlock[] {
  const content: WireContentBlock[] = []
  const text = flattenText(blocks)
  if (text.length > 0) content.push({ type: 'text', text })
  for (const block of blocks) {
    switch (block.type) {
      case 'image': {
        const resolved = images?.get(block.attachment.attachmentId)
        if (resolved === undefined) {
          throw new LlmError(
            'Claude Code image input requires the durable attachment service',
            'UNSUPPORTED_CONTENT',
          )
        }
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: resolved.mediaType, data: resolved.data },
        })
        break
      }
      case 'tool-result':
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: flattenText(block.content) || '(no output)',
          ...block.isError === true ? { is_error: true } : {},
        })
        break
      default:
        break
    }
  }
  return content
}

/** Serialize one assistant message (text + tool calls) into Anthropic content blocks. */
function serializeAssistant(message: Message): WireMessage {
  const content: WireContentBlock[] = []
  const text = flattenText(message.content)
  if (text.length > 0) content.push({ type: 'text', text })
  for (const block of message.content) {
    if (block.type === 'tool-call') {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        // Anthropic wants parsed JSON input, not the raw string. An empty
        // argument string means no arguments — an empty object on the wire.
        input: block.arguments.length > 0 ? JSON.parse(block.arguments) : {},
      })
    }
  }
  // An assistant turn with neither text nor tool calls still needs some content.
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return { role: 'assistant', content }
}

/**
 * Serialize the conversation into Anthropic messages. Harness tool-result and
 * image blocks ride in user-role messages; Anthropic wants them as typed content
 * blocks, also user-role — so a user turn contributes its text, images, and
 * tool results as blocks of one user message.
 * @param messages - the harness conversation, in order.
 * @param images - pre-resolved image bytes keyed by attachment id; undefined when no images exist.
 * @returns the wire messages; order preserved.
 */
export function serializeMessages(
  messages: Message[],
  images?: ReadonlyMap<string, ResolvedImage>,
): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // system and user roles both map to user-role content here; the harness
    // system prompt travels in the request `system` slot, not the message list.
    const content = serializeUserBlocks(message.content, images)
    if (content.length === 0) content.push({ type: 'text', text: '' })
    wire.push({ role: message.role === 'system' ? 'user' : message.role, content })
  }
  return wire
}

/**
 * Build the full Anthropic request with the Claude Code fingerprint. Always
 * streaming; the billing header leads `system`, and thinking/context/effort/
 * metadata are always present so the gateway admits the request.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - fingerprint facts from plugin config.
 * @param images - pre-resolved image bytes; undefined when no images exist.
 * @returns the messages request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults,
  images?: ReadonlyMap<string, ResolvedImage>,
): WireRequest {
  const system: WireSystemBlock[] = [
    { type: 'text', text: billingHeaderText(defaults.claudeCodeVersion) },
  ]
  if (options.system !== undefined && options.system.length > 0) {
    system.push({ type: 'text', text: options.system })
  }

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))

  return {
    model: options.model,
    system,
    messages: serializeMessages(options.messages, images),
    max_tokens: options.maxTokens ?? defaults.maxTokens,
    stream: true,
    thinking: { type: 'adaptive' },
    context_management: { edits: defaults.contextEdits },
    output_config: { effort: resolveEffort(options.reasoningEffort, defaults.defaultEffort) },
    metadata: { user_id: defaults.userId },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.stop !== undefined ? { stop_sequences: options.stop } : {},
  }
}
