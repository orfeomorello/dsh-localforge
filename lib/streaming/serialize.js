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
import { LlmError } from '@deepseek-ai/dsh-llm';
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
    return blocks
        .filter((b) => b.type === 'text')
        .map(b => b.text)
        .join('');
}
/** Encode one image reference into an OpenAI-compatible `data:` URL part. */
async function imagePartOf(attachment, store) {
    const stored = await store.readImage(attachment);
    return {
        type: 'image_url',
        image_url: {
            url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
        },
    };
}
/** Collect every image nested in a tool-result subtree into the active parts. */
async function gatherToolImages(blocks, pushImage) {
    for (const block of blocks) {
        if (block.type === 'image')
            await pushImage(block.attachment);
        else if (block.type === 'tool-result')
            await gatherToolImages(block.content, pushImage);
    }
}
/**
 * Serialize a user message's text+image input. Text-only input collapses
 * to a plain string; image input is an ordered part array of text and
 * `image_url` parts. Tool-result blocks contribute only their nested
 * images (the tool-result text rides its own `role: 'tool'` wire
 * message) and are otherwise skipped.
 *
 * @param blocks - the user message's content blocks.
 * @param attachments - the durable attachment store, or `undefined` when
 *   not mounted.
 * @returns the wire user content: a plain string when no image is
 *   present, else a part array.
 * @throws LlmError `UNSUPPORTED_CONTENT` when image input requires an
 *   unavailable attachment store.
 */
async function userWireContent(blocks, attachments) {
    const parts = [];
    let sawImage = false;
    const pushImage = async (attachment) => {
        if (attachments === undefined) {
            throw new LlmError('LocalForge image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
        }
        sawImage = true;
        parts.push(await imagePartOf(attachment, attachments));
    };
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                if (block.text.length > 0)
                    parts.push({ type: 'text', text: block.text });
                break;
            case 'image':
                await pushImage(block.attachment);
                break;
            case 'tool-result':
                await gatherToolImages(block.content, pushImage);
                break;
            default:
                // Other merge-extensible blocks are not user-input vocabulary for LM Studio.
                break;
        }
    }
    if (!sawImage) {
        return parts.map(p => p.text).join('');
    }
    return parts;
}
/** Serialize one assistant message (text + tool calls). */
function serializeAssistant(message) {
    const text = flattenText(message.content);
    const toolCalls = message.content
        .filter((b) => b.type === 'tool-call')
        .map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: b.arguments },
    }));
    return {
        role: 'assistant',
        // Tool-call-only turns send "" — never null — because some LM Studio
        // model backends reject null assistant content.
        content: text,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    };
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
 * @returns the wire messages; order preserved, each tool result
 *   expanded into its own entry.
 */
export async function serializeMessages(messages, attachments) {
    const wire = [];
    for (const message of messages) {
        if (message.role === 'system') {
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            wire.push(serializeAssistant(message));
            continue;
        }
        // user role: tool results ride in user messages in the harness
        // vocabulary, but OpenAI Chat Completions wants them as role:'tool'
        // messages.
        const toolResults = message.content
            .filter((b) => b.type === 'tool-result');
        const content = await userWireContent(message.content, attachments);
        if (typeof content === 'string') {
            if (content.length > 0 || toolResults.length === 0) {
                wire.push({ role: 'user', content });
            }
        }
        else if (content.length > 0) {
            wire.push({ role: 'user', content });
        }
        for (const result of toolResults) {
            wire.push({
                role: 'tool',
                tool_call_id: result.toolCallId,
                // Empty tool output still needs SOME content on the wire.
                content: flattenText(result.content) || '(no output)',
            });
        }
    }
    return wire;
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
 * @returns the chat-completions request body.
 */
export async function serializeRequest(options, attachments) {
    const messages = [];
    if (options.system !== undefined) {
        messages.push({ role: 'system', content: options.system });
    }
    messages.push(...await serializeMessages(options.messages, attachments));
    const tools = options.tools?.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            ...tool.description !== undefined ? { description: tool.description } : {},
            parameters: tool.parameters,
        },
    }));
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.stop !== undefined ? { stop: options.stop } : {},
    };
}
