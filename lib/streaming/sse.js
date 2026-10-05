/**
 * Decode an SSE byte stream into event `data` payloads.
 *
 * Framing — chunk reassembly, UTF-8 across chunk boundaries, CRLF, BOM,
 * comment and non-data field skipping, multi-`data:` joining — is
 * delegated to `eventsource-parser`. This module keeps the OpenAI
 * protocol contract: the literal `[DONE]` payload is yielded as the
 * final value, and an EOF before it raises `LlmError('STREAM_CLOSED')`
 * because a truncated response cannot be trusted.
 */
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { LlmError } from '@deepseek-ai/dsh-llm';
/** The terminal payload OpenAI-compatible servers send after the last chunk. */
export const DONE = '[DONE]';
/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream
 * ends without it (a truncated response that cannot be trusted).
 *
 * @param stream - raw SSE bytes; reads may split anywhere, including
 *   mid-UTF-8 sequence and mid-line.
 * @returns each event's data payload in arrival order, the `[DONE]`
 *   sentinel last.
 */
export async function* parseSse(stream) {
    const events = stream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());
    for await (const { data } of events) {
        yield data;
        if (data === DONE)
            return;
    }
    throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}
