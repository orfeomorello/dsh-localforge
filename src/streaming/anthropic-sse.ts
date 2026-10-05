/**
 * Parse an Anthropic-compatible SSE byte stream into typed events.
 *
 * Unlike the OpenAI protocol (which uses only `data:` lines and a
 * literal `[DONE]` sentinel), Anthropic SSE uses **named events**:
 * each event has both an `event:` field and a `data:` field, with the
 * `event` naming the type of payload in `data`. The standard
 * `eventsource-parser` handles this — the `EventSourceMessage` exposes
 * `event` and `data` separately.
 *
 * Stream shutdown rules:
 *  - the `message_stop` event terminates the stream normally;
 *  - an `error` event is surfaced as `LlmError`;
 *  - a `ping` event is ignored (it's a keepalive);
 *  - EOF without `message_stop` is `LlmError('STREAM_CLOSED')` — a
 *    truncated response cannot be trusted.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AnthropicEvent } from '../types/wire.ts'

const MESSAGE_STOP: AnthropicEvent = { type: 'message_stop' }

/**
 * Parse an Anthropic SSE byte stream into typed events. Yields each
 * event as it's received; `message_stop` is yielded as the final
 * value. An `error` event is thrown as an `LlmError` so the
 * translate layer sees it as a stream error.
 *
 * @param stream - raw SSE bytes; reads may split anywhere.
 * @returns each event in arrival order, `message_stop` last.
 */
export async function* parseAnthropicSse(
  stream: ReadableStream<BufferSource>,
): AsyncGenerator<AnthropicEvent> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
  for await (const { event, data } of events) {
    if (event === 'ping' || data === '') continue
    if (event === 'message_stop') {
      yield MESSAGE_STOP
      return
    }
    let parsed: AnthropicEvent
    try {
      parsed = JSON.parse(data) as AnthropicEvent
    } catch {
      throw new LlmError(`malformed Anthropic SSE data: ${data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    if (parsed.type === 'error') {
      throw new LlmError(parsed.error.message, 'SERVER', { cause: parsed })
    }
    yield parsed
  }
  throw new LlmError('Anthropic SSE stream ended without message_stop', 'STREAM_CLOSED')
}