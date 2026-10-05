/**
 * Serialize harness messages into an Anthropic `/v1/messages` request
 * body.
 *
 * Differences from the OpenAI wire:
 *
 *  - `system` is a separate top-level field (string or array of
 *    `{type:'text'}` blocks), not a `role:'system'` message. We
 *    flatten consecutive system messages into one and pass the
 *    remainder as the `system` field.
 *  - User messages are an array of typed blocks (`text`, `image`,
 *    `tool_result`). Tool results ride alongside user text.
 *  - Tool definitions use `input_schema` instead of `parameters`.
 *  - Tool calls in assistant messages use `tool_use` blocks.
 *  - `max_tokens` is required (Anthropic will reject without it).
 *  - `stop` is renamed `stop_sequences`.
 *  - Extended thinking uses `thinking: { type:'enabled',
 *    budget_tokens: N }`.
 *
 * Always streams (`stream: true`).
 */

import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicRequest,
  AnthropicSystemTextBlock,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
} from '../types/wire.ts'

/** Flatten the text blocks of a message's content. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Encode one image reference into an Anthropic image block. */
async function imageBlockOf(
  attachment: ImageAttachmentRef,
  store: AttachmentStore,
): Promise<AnthropicImageBlock> {
  const stored = await store.readImage(attachment)
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: stored.ref.mediaType,
      data: Buffer.from(stored.data).toString('base64'),
    },
  }
}

/** Serialize one user-role message into Anthropic user blocks. */
async function serializeUser(
  message: Message,
  attachments: AttachmentStore | undefined,
): Promise<AnthropicUserContentBlock[]> {
  const blocks: AnthropicUserContentBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) {
          blocks.push({ type: 'text', text: block.text })
        }
        break
      case 'image': {
        if (attachments === undefined) {
          throw new Error('LocalForge Anthropic image input requires the durable attachment service')
        }
        blocks.push(await imageBlockOf(block.attachment, attachments))
        break
      }
      case 'tool-result': {
        const inner: AnthropicTextBlock[] = flattenText(block.content).length > 0
          ? [{ type: 'text', text: flattenText(block.content) || '(no output)' }]
          : []
        const tr: AnthropicToolResultBlock = {
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: inner.length > 0 ? inner : '(no output)',
        }
        blocks.push(tr)
        break
      }
      case 'reasoning':
        // Anthropic does not have a "user reasoning" block; treat as text
        if (block.text.length > 0) {
          blocks.push({ type: 'text', text: block.text })
        }
        break
      case 'tool-call':
        // tool-call inside a user message is unexpected; skip safely
        break
    }
  }
  return blocks
}

/** Serialize one assistant-role message into Anthropic assistant blocks. */
function serializeAssistant(message: Message): AnthropicAssistantContentBlock[] {
  const blocks: AnthropicAssistantContentBlock[] = []
  const text = flattenText(message.content)
  if (text.length > 0) blocks.push({ type: 'text', text })
  for (const block of message.content) {
    if (block.type === 'tool-call') {
      const t: AnthropicToolUseBlock = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parseJsonSafe(block.arguments),
      }
      blocks.push(t)
    }
  }
  return blocks
}

/** Parse a JSON arguments string safely; empty string → empty object. */
function parseJsonSafe(s: string): Record<string, unknown> {
  if (s.length === 0) return {}
  try {
    const parsed = JSON.parse(s) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* fall through */ }
  return {}
}

/**
 * Build the full Anthropic-style messages request body.
 *
 * Consecutive `role: 'system'` messages are concatenated into a single
 * `system` field (string when there's only one, array of blocks when
 * there are multiple, to preserve order and allow each to carry
 * different metadata if needed).
 *
 * @param options - the harness request.
 * @param attachments - the durable attachment store.
 * @param defaultMaxTokens - the route-level max_tokens default (the
 *   Anthropic API requires `max_tokens`; we never omit it).
 */
export async function serializeAnthropicRequest(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
  defaultMaxTokens: number,
): Promise<AnthropicRequest> {
  // 1. collect and fold system messages
  const systemTexts: string[] = []
  const messages: AnthropicRequest['messages'] = []
  for (const m of options.messages) {
    if (m.role === 'system') {
      const t = flattenText(m.content)
      if (t.length > 0) systemTexts.push(t)
      continue
    }
    if (m.role === 'assistant') {
      const content = serializeAssistant(m)
      if (content.length > 0) messages.push({ role: 'assistant', content })
    } else {
      const content = await serializeUser(m, attachments)
      if (content.length > 0) messages.push({ role: 'user', content })
    }
  }

  // 2. the system field: prefer the explicit `options.system` if set,
  //    otherwise the concatenation of in-message system blocks.
  const systemFromOptions = options.system
  const system: string | AnthropicSystemTextBlock[] | undefined =
    systemFromOptions !== undefined
      ? (systemFromOptions.length > 0 ? systemFromOptions : undefined)
      : (systemTexts.length === 0
          ? undefined
          : systemTexts.length === 1
            ? (systemTexts[0] ?? '')
            : systemTexts.map(t => ({ type: 'text' as const, text: t })))

  // 3. tools
  const tools: AnthropicTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    ...tool.description !== undefined ? { description: tool.description } : {},
    input_schema: tool.parameters,
  }))

  // 4. assemble
  return {
    model: options.model,
    ...system !== undefined ? { system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    max_tokens: options.maxTokens ?? defaultMaxTokens,
    stream: true,
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.top_p !== undefined ? { top_p: options.top_p } : {},
    ...options.stop !== undefined ? { stop_sequences: Array.isArray(options.stop) ? options.stop : [options.stop] } : {},
  }
}