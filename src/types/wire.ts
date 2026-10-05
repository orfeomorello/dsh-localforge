/**
 * Wire types for the OpenAI-compatible chat completions protocol and
 * the Anthropic-compatible messages protocol.
 *
 * These are the JSON shapes that LM Studio (and any other compatible
 * server) emit and accept. They live in their own module so the
 * serializers and translators can share the types without circular
 * imports.
 *
 * Only the fields `dsh-localforge` actually uses are typed; unknown
 * fields pass through untouched.
 */

// -- OpenAI-compatible wire types -----------------------------------------

/** One text content part of a user message. */
export interface WireTextPart {
  type: 'text'
  text: string
}

/** One image content part of a user message, encoded as a data URL. */
export interface WireImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** A user message, either a plain string or an array of mixed parts. */
export type WireUserContent = string | (WireTextPart | WireImagePart)[]

/** A tool definition in the OpenAI style. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: unknown
  }
}

/** One tool call emitted by the assistant in the streamed response. */
export interface WireToolCall {
  index: number
  id?: string
  type: 'function'
  function: { name?: string; arguments?: string }
}

/** One chat message in the request body. */
export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: WireUserContent }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** The full chat-completions request body. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  top_p?: number
  top_k?: number
  frequency_penalty?: number
  presence_penalty?: number
  max_tokens?: number
  stop?: string | string[]
  reasoning_effort?: 'low' | 'medium' | 'high'
}

/** Reasoning deltas emitted by some models alongside text. */
export interface WireDelta {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCall[]
}

/** One choice in a streamed chunk. */
export interface WireChoice {
  index: number
  delta: WireDelta
  finish_reason?: string | null
}

/** Prompt-token accounting detail. */
export interface WirePromptTokensDetails {
  cached_tokens?: number
}

/** Completion-token accounting detail. */
export interface WireCompletionTokensDetails {
  reasoning_tokens?: number
}

/** Usage block attached to a finish or trailing usage-only chunk. */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: WirePromptTokensDetails
  completion_tokens_details?: WireCompletionTokensDetails
}

/** One SSE chunk in a streamed response. */
export interface WireChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: WireChoice[]
  usage?: WireUsage
}

/** A non-2xx response body in the OpenAI error shape. */
export interface WireError {
  error: {
    message: string
    type?: string
    code?: string | number
    param?: string
  }
}

// -- Anthropic-compatible wire types -------------------------------------

/** Cache-control directive for a system or tool block. */
export interface AnthropicCacheControl {
  type: 'ephemeral'
}

/** A system-prompt text block. */
export interface AnthropicSystemTextBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

/** A user-role text block. */
export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

/** A user-role image block (base64 source). */
export interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
  cache_control?: AnthropicCacheControl
}

/** A tool-use block emitted by the assistant. */
export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: AnthropicCacheControl
}

/** A tool-result block in a user message. */
export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | AnthropicTextBlock[]
  is_error?: boolean
  cache_control?: AnthropicCacheControl
}

/** A user-role message (one of several block kinds). */
export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock

/** An assistant-role message. */
export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock

/** A tool definition in the Anthropic style. */
export interface AnthropicTool {
  name: string
  description?: string
  input_schema: unknown
  cache_control?: AnthropicCacheControl
}

/** The full Anthropic-style messages request body. */
export interface AnthropicRequest {
  model: string
  system?: string | AnthropicSystemTextBlock[]
  messages: Array<
    | { role: 'user'; content: AnthropicUserContentBlock[] }
    | { role: 'assistant'; content: AnthropicAssistantContentBlock[] }
  >
  tools?: AnthropicTool[]
  max_tokens: number
  stream: true
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  metadata?: { user_id?: string }
  thinking?: { type: 'enabled'; budget_tokens: number }
}

// -- Anthropic SSE event types --------------------------------------------

/** `message_start` event. */
export interface AnthropicMessageStart {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: []
    model: string
    stop_reason: null
    stop_sequence: null
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  }
}

/** `content_block_start` event. */
export interface AnthropicContentBlockStart {
  type: 'content_block_start'
  index: number
  content_block:
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
}

/** `content_block_delta` event. */
export interface AnthropicContentBlockDelta {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string }
    | { type: 'input_json_delta'; partial_json: string }
}

/** `content_block_stop` event. */
export interface AnthropicContentBlockStop {
  type: 'content_block_stop'
  index: number
}

/** `message_delta` event (incremental message updates). */
export interface AnthropicMessageDelta {
  type: 'message_delta'
  delta: {
    stop_reason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
    stop_sequence?: string | null
  }
  usage: { output_tokens: number; input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

/** `message_stop` event. */
export interface AnthropicMessageStop {
  type: 'message_stop'
}

/** `ping` event. */
export interface AnthropicPing {
  type: 'ping'
}

/** `error` event. */
export interface AnthropicErrorEvent {
  type: 'error'
  error: { type: string; message: string }
}

/** Any Anthropic SSE event. */
export type AnthropicEvent =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicContentBlockStop
  | AnthropicMessageDelta
  | AnthropicMessageStop
  | AnthropicPing
  | AnthropicErrorEvent