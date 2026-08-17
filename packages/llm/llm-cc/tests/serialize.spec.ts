import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createMessage, createUserMessage, CallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { billingHeaderText, serializeMessages, serializeRequest } from '../src/serialize.ts'
import type { RequestDefaults } from '../src/serialize.ts'

const DEFAULTS: RequestDefaults = {
  claudeCodeVersion: '2.1.228',
  userId: '{"device_id":"dev","account_uuid":"","session_id":"dev"}',
  contextEdits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
  defaultEffort: 'high',
  maxTokens: 64_000,
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'cc', model: 'claude-opus-4-8', messages: [], ...overrides }
}

const SOURCE = { kind: 'plugin', plugin: 'test' } as const

describe('billingHeaderText', () => {
  it('embeds the version in the fixed gateway format', () => {
    expect(billingHeaderText('2.1.228'))
      .toBe('x-anthropic-billing-header: cc_version=2.1.228; cc_entrypoint=cli;')
  })
})

describe('serializeMessages', () => {
  it('joins user text into one text block', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }])
  })

  it('maps system-role history to a user-role message', () => {
    const wire = serializeMessages([
      createMessage({ role: 'system', content: [{ type: 'text', text: 'be brief' }], source: SOURCE }),
    ])
    expect(wire).toEqual([{ role: 'user', content: [{ type: 'text', text: 'be brief' }] }])
  })

  it('maps assistant text plus a tool call, parsing arguments to input', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'dropped' },
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: 'Paris' } },
      ],
    }])
  })

  it('treats empty tool-call arguments as an empty input object', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: '' }],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'f', input: {} }] }])
  })

  it('serializes parallel tool calls in order', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: CallId('a'), name: 'one', arguments: '{}' },
          { type: 'tool-call', id: CallId('b'), name: 'two', arguments: '{}' },
        ],
        source: SOURCE,
      }),
    ])
    const assistant = wire[0] as { content: { id?: string }[] }
    expect(assistant.content.map(block => block.id)).toEqual(['a', 'b'])
  })

  it('emits a placeholder text block for a content-less assistant turn', () => {
    const wire = serializeMessages([createMessage({ role: 'assistant', content: [], source: SOURCE })])
    expect(wire).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '' }] }])
  })

  it('turns tool results into user-role tool_result blocks', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Sunny 22C' }],
    }])
  })

  it('sends a sentinel for empty tool-result content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [] }],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '(no output)' }],
    }])
  })

  it('marks an error tool result with is_error', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        }],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'boom', is_error: true }],
    }])
  })

  it('keeps user text and its tool results in one user message', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'text', text: 'context note' },
          { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }] },
        ],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'context note' },
        { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' },
      ],
    }])
  })

  it('skips plugin-added block types (merge-extensible ContentBlockMap)', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'chart', data: 'x' } as unknown as ContentBlock,
          { type: 'text', text: 'see chart' },
        ],
        source: SOURCE,
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: [{ type: 'text', text: 'see chart' }] }])
  })

  it('emits an empty user message rather than dropping a block-less user turn', () => {
    const wire = serializeMessages([createUserMessage({ content: [], source: SOURCE })])
    expect(wire).toEqual([{ role: 'user', content: [{ type: 'text', text: '' }] }])
  })

  it('rejects image blocks instead of silently flattening them away', () => {
    expect(() => serializeMessages([createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png', bytes: 68, width: 1, height: 1,
        },
      }],
      source: SOURCE,
    })])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })
})

describe('serializeRequest: fingerprint', () => {
  const history: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: SOURCE })]

  it('always streams and injects the full Claude Code fingerprint', () => {
    const wire = serializeRequest(request({ messages: history }), DEFAULTS)
    expect(wire).toEqual({
      model: 'claude-opus-4-8',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.228; cc_entrypoint=cli;' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 64_000,
      stream: true,
      thinking: { type: 'adaptive' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      output_config: { effort: 'high' },
      metadata: { user_id: DEFAULTS.userId },
    })
  })

  it('appends the system prompt after the billing header', () => {
    const wire = serializeRequest(request({ messages: history, system: 'be helpful' }), DEFAULTS)
    expect(wire.system).toEqual([
      { type: 'text', text: billingHeaderText('2.1.228') },
      { type: 'text', text: 'be helpful' },
    ])
  })

  it('omits an empty system prompt, keeping only the billing header', () => {
    expect(serializeRequest(request({ messages: history, system: '' }), DEFAULTS).system).toHaveLength(1)
  })

  it('maps sampling params and stop sequences', () => {
    const wire = serializeRequest(
      request({ messages: history, temperature: 0.2, maxTokens: 100, stop: ['END'] }),
      DEFAULTS,
    )
    expect(wire.temperature).toBe(0.2)
    expect(wire.max_tokens).toBe(100)
    expect(wire.stop_sequences).toEqual(['END'])
  })

  it('falls back to the default max_tokens when the request sets none', () => {
    expect(serializeRequest(request({ messages: history }), DEFAULTS).max_tokens).toBe(64_000)
  })

  it('maps tools to the Anthropic input_schema shape', () => {
    const wire = serializeRequest(request({
      messages: history,
      tools: [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
      ],
    }), DEFAULTS)
    expect(wire.tools).toEqual([
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'B', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
    ])
  })

  it('omits an empty tools array', () => {
    expect(serializeRequest(request({ messages: history, tools: [] }), DEFAULTS).tools).toBeUndefined()
  })
})

describe('serializeRequest: effort mapping', () => {
  it('uses the adapter default effort when the request selects none', () => {
    expect(serializeRequest(request(), { ...DEFAULTS, defaultEffort: 'max' }).output_config)
      .toEqual({ effort: 'max' })
  })

  it.each([
    ['off', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
  ] as const)('maps request effort %s to %s', (effort, expected) => {
    const wire = serializeRequest(request({ reasoningEffort: ReasoningEffortId(effort) }), DEFAULTS)
    expect(wire.output_config.effort).toBe(expected)
  })

  it('rejects an unsupported reasoning effort', () => {
    expect(() => serializeRequest(
      request({ reasoningEffort: ReasoningEffortId('ludicrous') }),
      DEFAULTS,
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })
})
