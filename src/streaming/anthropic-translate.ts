/**
 * Translate Anthropic `/v1/messages` SSE events into harness
 * `StreamChunk`s.
 *
 * Maintains one stateful block per content-block index, four block
 * kinds (`text`, `thinking`, `tool_use` — with a partial-JSON
 * accumulator — and `redacted_thinking`, which we surface as a
 * `reasoning` block with a sentinel). Finish reason and the latest
 * usage are deferred until `message_stop`.
 *
 * Tool-use argument deltas are `input_json_delta` events carrying a
 * fragment of the final JSON. We accumulate the partial JSON and
 * emit a `tool-call-delta` per fragment; the harness closes the
 * block on `content_block_stop` and parses the accumulated JSON
 * string as the `arguments` field.
 *
 * `ping` events are dropped silently. A `message_stop` without any
 * open blocks is a degenerate completion and maps to
 * `EMPTY_RESPONSE`.
 */

import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  AnthropicContentBlockDelta,
  AnthropicContentBlockStart,
  AnthropicEvent,
  AnthropicMessageDelta,
  AnthropicMessageStart,
  AnthropicToolUseBlock,
} from '../types/wire.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call' | 'redacted-thinking'
  text: string
  callId?: string
  name?: string
}

/**
 * Map Anthropic's `stop_reason` vocabulary to the harness
 * `FinishReason`. Unrecognized values become `{kind: 'error'}`.
 */
function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn': return { kind: 'stop' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'stop_sequence': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case null: case undefined: return { kind: 'stop' }
    default: return {
      kind: 'error',
      failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
    }
  }
}

/** Assemble the final `ContentBlock` for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'redacted-thinking': return { type: 'reasoning', text: '[redacted thinking]' }
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/** Handle a `message_start` event (no chunks emitted). */
function applyMessageStart(_e: AnthropicMessageStart, _state: TranslateState): void {
  // No content yet; the message metadata is for the harness's
  // own bookkeeping if needed (e.g. request id correlation). We
  // surface the input/output token baseline via the trailing usage.
}

/** Handle a `content_block_start` event. */
function applyContentBlockStart(
  e: AnthropicContentBlockStart,
  state: TranslateState,
): StreamChunk | undefined {
  const { index, content_block } = e
  let block: OpenBlock
  switch (content_block.type) {
    case 'text':
      block = { index, kind: 'text', text: '' }
      break
    case 'thinking':
      block = { index, kind: 'reasoning', text: '' }
      break
    case 'redacted_thinking':
      block = { index, kind: 'redacted-thinking', text: '' }
      break
    case 'tool_use':
      block = {
        index,
        kind: 'tool-call',
        text: '',
        callId: content_block.id,
        name: content_block.name,
      }
      break
  }
  state.blocks.set(index, block)
  state.order.push(block)
  const blockType = block.kind === 'tool-call' ? 'tool-call'
    : block.kind === 'text' ? 'text'
    : 'reasoning'
  return { type: 'block-start', index, blockType }
}

/** Handle a `content_block_delta` event. */
function applyContentBlockDelta(
  e: AnthropicContentBlockDelta,
  state: TranslateState,
): StreamChunk | undefined {
  const block = state.blocks.get(e.index)
  if (block === undefined) {
    // Out-of-order delta without a start; emit a synthetic text block
    // so the chunk stream is well-formed.
    const synthetic: OpenBlock = { index: e.index, kind: 'text', text: '' }
    state.blocks.set(e.index, synthetic)
    state.order.push(synthetic)
  }
  const target = state.blocks.get(e.index)
  if (target === undefined) return undefined

  switch (e.delta.type) {
    case 'text_delta': {
      target.text += e.delta.text
      return { type: 'text-delta', index: e.index, text: e.delta.text }
    }
    case 'thinking_delta': {
      target.text += e.delta.thinking
      return { type: 'reasoning-delta', index: e.index, text: e.delta.thinking }
    }
    case 'signature_delta': {
      // no-op for our purposes; the signature is for safety filtering
      return undefined
    }
    case 'input_json_delta': {
      // accumulate the partial JSON; the harness will parse it on close
      target.text += e.delta.partial_json
      return {
        type: 'tool-call-delta',
        index: e.index,
        id: ToolCallId(target.callId ?? ''),
        ...target.name !== undefined ? { name: target.name } : {},
        argumentsDelta: e.delta.partial_json,
      }
    }
  }
}

/** Handle a `content_block_stop` event. */
function applyContentBlockStop(e: AnthropicContentBlockStop, _state: TranslateState): StreamChunk | undefined {
  // We don't have the block here; the caller emits `block-end` on
  // `message_stop` for every open block, in order. (Emitting one
  // per `content_block_stop` would interleave badly with subsequent
  // deltas that share the same `index` in pathological servers.)
  return undefined
}

/** Handle a `message_delta` event (stop reason + cumulative usage). */
function applyMessageDelta(e: AnthropicMessageDelta, state: TranslateState): void {
  state.pendingFinish = mapStopReason(e.delta.stop_reason)
  if (e.usage !== undefined) {
    state.usage = {
      inputTokens: e.usage.input_tokens ?? 0,
      outputTokens: e.usage.output_tokens,
    }
  }
}

/** Mutable state carried across events. */
interface TranslateState {
  blocks: Map<number, OpenBlock>
  order: OpenBlock[]
  pendingFinish: FinishReason | undefined
  usage: TokenUsage | undefined
}

/**
 * Consume Anthropic SSE events (ending with `message_stop`) and yield
 * `StreamChunk`s.
 *
 * @param events - typed events from {@link parseAnthropicSse}.
 */
export async function* translateAnthropic(
  events: AsyncIterable<AnthropicEvent>,
): AsyncGenerator<StreamChunk> {
  const state: TranslateState = {
    blocks: new Map(),
    order: [],
    pendingFinish: undefined,
    usage: undefined,
  }

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        applyMessageStart(ev, state)
        break
      case 'content_block_start': {
        const chunk = applyContentBlockStart(ev, state)
        if (chunk !== undefined) yield chunk
        break
      }
      case 'content_block_delta': {
        const chunk = applyContentBlockDelta(ev, state)
        if (chunk !== undefined) yield chunk
        break
      }
      case 'content_block_stop':
        // emitted on message_stop
        break
      case 'message_delta':
        applyMessageDelta(ev, state)
        break
      case 'message_stop': {
        // close all blocks in order, then emit usage + finish
        for (const block of state.order) {
          yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        }
        if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
        const reason = state.pendingFinish ?? ({ kind: 'stop' as const })
        yield {
          type: 'finish',
          reason: reason.kind === 'stop' && state.order.length === 0
            ? {
                kind: 'error',
                failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
              }
            : reason,
        }
        return
      }
      case 'ping':
        // keepalive; skip
        break
      case 'error':
        // parseAnthropicSse throws on error events; this is unreachable
        throw new LlmError(ev.error.message, 'SERVER', { cause: ev })
    }
  }
  // parseAnthropicSse throws on premature EOF; reaching here means
  // the stream ended cleanly without message_stop — also a violation.
  throw new LlmError('Anthropic SSE stream ended without message_stop', 'STREAM_CLOSED')
}