import { describe, expect, it } from 'vitest'
import { BlockAssembler, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { mapStopReason, mapUsage, translate } from '../src/translate.ts'

async function* feed(...payloads: (string | object)[]): AsyncGenerator<string> {
  for (const payload of payloads) {
    yield typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const start = { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }
const stop = { type: 'message_stop' }

describe('translate: text', () => {
  it('streams a text block, defers usage and finish to message_delta/message_stop', async () => {
    const chunks = await collect(translate(feed(
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      stop,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles into the message BlockAssembler expects', async () => {
    const assembler = new BlockAssembler()
    for await (const chunk of translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    ))) {
      assembler.push(chunk)
    }
    expect(assembler.message().content).toEqual([{ type: 'text', text: 'hi' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
  })
})

describe('translate: reasoning', () => {
  it('streams a thinking block as reasoning then text as a separate block', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mull' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'mull' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'mull' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translate: tool calls', () => {
  it('opens a tool-call block with id+name and reassembles fragmented json input', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ': "Paris"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
      stop,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '{"city"' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: ': "Paris"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city": "Paris"}' },
      },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 6 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('disambiguates parallel tool calls by wire index', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'one' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'two' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      stop,
    )))
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends).toEqual([
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'a', name: 'one', arguments: '{}' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'b', name: 'two', arguments: '{}' } },
    ])
  })
})

describe('translate: finish and usage handling', () => {
  it('emits usage from message_start alone when message_delta reports none', async () => {
    const chunks = await collect(translate(feed(
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } })
  })

  it('merges message_start input tokens with message_delta output and cache counts', async () => {
    const chunks = await collect(translate(feed(
      { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 9, cache_creation_input_tokens: 12 },
      },
      stop,
    )))
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 40, cacheWriteTokens: 12 },
    })
  })

  it('treats a message_start without a usage object as no usage', async () => {
    const chunks = await collect(translate(feed(
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      stop,
    )))
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 3 },
    })
  })

  it('emits an id-less, name-less tool-call delta for json arriving on a text block', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks.find(chunk => chunk.type === 'tool-call-delta')).toEqual({
      type: 'tool-call-delta',
      index: 0,
      id: '',
      argumentsDelta: '{"x":1}',
    })
  })

  it('omits the usage chunk when neither event reported usage', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      stop,
    )))
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('classifies an explicit stop with no opened blocks as EMPTY_RESPONSE, after usage', async () => {
    const chunks = await collect(translate(feed(
      { type: 'message_start', message: { usage: { input_tokens: 7 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      },
    ])
  })

  it('classifies message_stop with no prior message_delta as an empty stop', async () => {
    const chunks = await collect(translate(feed(stop)))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    }])
  })

  it('keeps a reasoning-only stream a successful stop (any opened block counts)', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mull' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a non-stop finish unclassified even with no opened blocks', async () => {
    const chunks = await collect(translate(feed(
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      stop,
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('ignores a delta for an index that never opened', async () => {
    const chunks = await collect(translate(feed(
      { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'orphan' } },
      { type: 'content_block_stop', index: 9 },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'real' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: 'real' },
    ])
  })

  it('skips ping events', async () => {
    const chunks = await collect(translate(feed(
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      stop,
    )))
    expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(true)
  })
})

describe('translate: errors', () => {
  it('throws MALFORMED_RESPONSE for invalid JSON payloads', async () => {
    await expect(collect(translate(feed('{bad json')))).rejects.toThrow(LlmError)
    await expect(collect(translate(feed('{bad json')))).rejects.toThrow(/malformed SSE payload/)
  })

  it('throws PROVIDER_ERROR on an error event, preferring the message', async () => {
    await expect(collect(translate(feed(
      { type: 'error', error: { type: 'overloaded_error', message: 'server overloaded' } },
    )))).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: /server overloaded/ })
  })

  it('falls back to the error type, then to unknown, on a bare error event', async () => {
    await expect(collect(translate(feed({ type: 'error', error: { type: 'overloaded_error' } }))))
      .rejects.toMatchObject({ message: /overloaded_error/ })
    await expect(collect(translate(feed({ type: 'error' }))))
      .rejects.toMatchObject({ message: /unknown/ })
  })

  it('throws STREAM_CLOSED when the payloads end without message_stop', async () => {
    await expect(collect(translate(feed(
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    )))).rejects.toMatchObject({ code: 'STREAM_CLOSED', message: /without message_stop/ })
  })
})

describe('mapStopReason', () => {
  it.each([
    ['end_turn', { kind: 'stop' }],
    ['stop_sequence', { kind: 'stop' }],
    ['tool_use', { kind: 'tool-calls' }],
    ['max_tokens', { kind: 'max-tokens' }],
  ] as const)('maps %s', (wire, expected) => {
    expect(mapStopReason(wire)).toEqual(expected)
  })

  it.each([null, undefined])('maps %s to stop', (wire) => {
    expect(mapStopReason(wire)).toEqual({ kind: 'stop' })
  })

  it('maps an unrecognized reason to an error kind with the uppercased code', () => {
    expect(mapStopReason('refusal')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: refusal', code: 'REFUSAL' },
    })
  })
})

describe('mapUsage', () => {
  it('maps the full cache-aware shape', () => {
    expect(mapUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 12,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 12,
    })
  })

  it('defaults absent token counts to zero and omits absent cache fields', () => {
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})
