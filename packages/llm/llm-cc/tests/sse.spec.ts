import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/sse.ts'

/**
 * Protocol contract only: parseSse yields every event's data payload in order
 * and returns at EOF. Unlike the OpenAI protocol there is no `[DONE]` sentinel,
 * so detecting a truncated stream is the translator's job, not this module's.
 * SSE framing (chunk splits, CRLF, multi-data joins) is eventsource-parser's
 * contract, not re-proven here.
 */

/** Build an SSE byte stream from string fragments (fragments = network reads). */
function bytes(...fragments: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const fragment of fragments) controller.enqueue(encoder.encode(fragment))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe('parseSse', () => {
  it('yields every event data payload in arrival order', async () => {
    const events = await collect(parseSse(bytes(
      'data: {"type":"ping"}\n\ndata: {"type":"message_stop"}\n\n',
    )))
    expect(events).toEqual(['{"type":"ping"}', '{"type":"message_stop"}'])
  })

  it('reports comments out of band without yielding them', async () => {
    const comments: string[] = []
    const events = await collect(parseSse(
      bytes(': keep-alive\n\ndata: {"a":1}\n\n'),
      (comment) => { comments.push(comment) },
    ))
    expect(comments).toEqual(['keep-alive'])
    expect(events).toEqual(['{"a":1}'])
  })

  it('returns cleanly at end of stream (no [DONE] sentinel to await)', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\n\n')))
    expect(events).toEqual(['{"a":1}'])
  })

  it('returns an empty payload list for an empty stream', async () => {
    expect(await collect(parseSse(bytes()))).toEqual([])
  })

  it('drops an unterminated tail event at EOF (spec-strict framing)', async () => {
    // An event dispatches only on its blank-line terminator, so a partial tail
    // is not yielded; the translator sees the truncation as a missing
    // message_stop.
    expect(await collect(parseSse(bytes('data: {"a"')))).toEqual([])
  })
})
