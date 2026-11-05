/**
 * Serialize harness messages into an OpenAI Chat Completions request body.
 *
 * User text is joined into a single string; assistant text becomes the
 * `content` field and tool calls become `tool_calls`; tool results become
 * separate `role: 'tool'` messages (the OpenAI protocol wants tool
 * results as their own message, not nested inside a user message).
 *
 * Assistant reasoning is not replayed: LM Studio does not require
 * reasoning passback, and omitting it keeps tool-round-trip token cost
 * down. Image blocks resolve through the durable attachment store into
 * OpenAI `image_url` parts (`data:` URLs); with no attachment store
 * mounted, image input fails `UNSUPPORTED_CONTENT` and text-only
 * requests proceed unchanged.
 *
 * Always streams (`stream: true`, usage reporting on). Optional fields
 * are omitted rather than sent as null, so provider defaults apply.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  expandDocumentOrImagePath,
  expandTextWithLocalDocuments,
  type DocumentExpandOptions,
  type ExtractedVisionImage,
} from '../document/pdf-and-image.ts'
import type {
  WireImagePart,
  WireMessage,
  WireRequest,
  WireTextPart,
  WireTool,
} from '../types/wire.ts'

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Encode one image reference into an OpenAI-compatible `data:` URL part. */
async function imagePartOf(attachment: ImageAttachmentRef, store: AttachmentStore): Promise<WireImagePart> {
  const stored = await store.readImage(attachment)
  return {
    type: 'image_url',
    image_url: {
      url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
    },
  }
}

/** Convert an extracted Vision image into an OpenAI-compatible `data:` URL part. */
function visionImageToWirePart(img: ExtractedVisionImage): WireImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${img.mediaType};base64,${img.base64}`,
    },
  }
}

/** Collect every image nested in a tool-result subtree into the active parts. */
async function gatherToolImages(
  blocks: readonly ContentBlock[],
  pushImage: (attachment: ImageAttachmentRef) => Promise<void>,
  pushVisionImage: (img: ExtractedVisionImage) => void,
  docOptions: DocumentExpandOptions | undefined,
): Promise<void> {
  for (const block of blocks) {
    if (block.type === 'image') {
      await pushImage(block.attachment)
    } else if (block.type === 'text') {
      const expanded = await expandTextWithLocalDocuments(block.text, docOptions)
      for (const img of expanded.images) pushVisionImage(img)
    } else if (block.type === 'tool-result') {
      await gatherToolImages(block.content, pushImage, pushVisionImage, docOptions)
    }
  }
}

/**
 * Serialize a user message's text+image input. Text-only input collapses
 * to a plain string; image input is an ordered part array of text and
 * `image_url` parts. Tool-result blocks contribute only their nested
 * images (the tool-result text rides its own `role: 'tool'` wire
 * message) and are otherwise skipped.
 *
 * Also automatically expands `dsh` file handles (`[File "..." saved at "..."]`),
 * direct `file` blocks (when attachment store provides `resolveFileReadPath`),
 * and explicit local `.pdf` / `.png` / `.jpg` / `.webp` / `.gif` paths into
 * extracted text + Vision `image_url` parts.
 *
 * @param blocks - the user message's content blocks.
 * @param attachments - the durable attachment store, or `undefined` when
 *   not mounted.
 * @param docOptions - PDF and local image expansion options.
 * @returns the wire user content: a plain string when no image is
 *   present, else a part array.
 * @throws LlmError `UNSUPPORTED_CONTENT` when image input requires an
 *   unavailable attachment store.
 */
async function userWireContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  docOptions?: DocumentExpandOptions,
): Promise<string | (WireTextPart | WireImagePart)[]> {
  const parts: (WireTextPart | WireImagePart)[] = []
  let sawImage = false

  const pushImage = async (attachment: ImageAttachmentRef): Promise<void> => {
    if (attachments === undefined) {
      throw new LlmError('LocalForge image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    sawImage = true
    parts.push(await imagePartOf(attachment, attachments))
  }

  const pushVisionImage = (img: ExtractedVisionImage): void => {
    sawImage = true
    parts.push(visionImageToWirePart(img))
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        if (block.text.length > 0) {
          const expanded = await expandTextWithLocalDocuments(block.text, docOptions)
          parts.push({ type: 'text', text: expanded.text })
          for (const img of expanded.images) pushVisionImage(img)
        }
        break
      }
      case 'image':
        await pushImage(block.attachment)
        break
      case 'file': {
        const fileBlock = block as unknown as { type: 'file'; attachment: FileAttachmentRef }
        const filePath = attachments?.fileHostPath(fileBlock.attachment)
        if (filePath !== undefined) {
          const expanded = await expandDocumentOrImagePath(filePath, docOptions)
          if (expanded !== undefined) {
            parts.push({ type: 'text', text: expanded.textSummary })
            for (const img of expanded.images) pushVisionImage(img)
          }
        }
        break
      }
      case 'tool-result':
        await gatherToolImages(block.content, pushImage, pushVisionImage, docOptions)
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for LM Studio.
        break
    }
  }
  if (!sawImage) {
    return parts
      .filter((p): p is WireTextPart => p.type === 'text')
      .map(p => p.text)
      .join('')
  }
  return parts
}

/** Serialize one assistant message (text + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
    .map((b, idx) => ({
      index: idx,
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: b.arguments },
    }))

  return {
    role: 'assistant',
    // Tool-call-only turns send "" — never null — because some LM Studio
    // model backends reject null assistant content.
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its
 * own user-role message, so a mixed user message contributes its text
 * first and its tool results as separate wire messages after. User
 * image input resolves through `attachments` into multimodal user
 * content.
 *
 * @param messages - the harness conversation, in order.
 * @param attachments - the durable attachment store, or `undefined`
 *   when not mounted.
 * @param docOptions - PDF and local image expansion options.
 * @returns the wire messages; order preserved, each tool result
 *   expanded into its own entry.
 */
export async function serializeMessages(
  messages: readonly Message[],
  attachments?: AttachmentStore,
  docOptions?: DocumentExpandOptions,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but OpenAI Chat Completions wants them as role:'tool'
    // messages.
    const toolResults = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool-result' }> => b.type === 'tool-result')
    const content = await userWireContent(message.content, attachments, docOptions)
    if (typeof content === 'string') {
      if (content.length > 0 || toolResults.length === 0) {
        wire.push({ role: 'user', content })
      }
    } else if (content.length > 0) {
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      const rawToolText = flattenText(result.content)
      const expandedTool = await expandTextWithLocalDocuments(rawToolText, docOptions)
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: expandedTool.text || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null,
 * so provider defaults apply.
 *
 * @param options - the harness request (model, history, system, tools,
 *   sampling).
 * @param attachments - the durable attachment store, or `undefined`
 *   when not mounted.
 * @param docOptions - PDF and local image expansion options.
 * @returns the chat-completions request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  attachments?: AttachmentStore,
  docOptions?: DocumentExpandOptions,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessages(options.messages, attachments, docOptions))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...tool.description !== undefined ? { description: tool.description } : {},
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}