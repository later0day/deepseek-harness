/**
 * Decode an Anthropic messages SSE byte stream into event `data` payloads.
 * Framing — chunk reassembly, UTF-8/CRLF/BOM handling, comment and non-data
 * field skipping, multi-`data:` joining — is `eventsource-parser`'s. Unlike the
 * OpenAI protocol there is no `[DONE]` sentinel: the terminal is the
 * `message_stop` event, which {@link ../translate} detects. This module yields
 * every data payload in arrival order and returns at end of stream; detecting a
 * truncated response (EOF before `message_stop`) is the translator's job, since
 * only it parses the event types.
 *
 * @module dsh-llm-cc/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'

/**
 * Parse an SSE byte stream into data payloads.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
  }
}
