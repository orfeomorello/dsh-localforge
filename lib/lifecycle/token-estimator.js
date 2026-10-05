/**
 * Real, tokenizer-accurate pre-flight context-overflow guard.
 *
 * Uses `gpt-tokenizer` (via the {@link TokenCounter} factory) for
 * text blocks and tool definitions. Image blocks have a fixed token
 * cost (the rough OpenAI low-res vision cost). Reasoning and tool-call
 * argument blocks count their text/argument text.
 *
 * A real tokenizer is finally available across model families
 * because `gpt-tokenizer` ships the BPE tables in pure JavaScript
 * with no native bindings and no WASM init. The previous
 * `chars / 3.5` heuristic is no longer used.
 */
/** OpenAI's rough token cost for a low-res image. */
const IMAGE_TOKENS = 765;
/** Count the input tokens of one message's content. */
function countMessageTokens(blocks, counter) {
    let total = 0;
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                total += counter(block.text);
                break;
            case 'image':
                total += IMAGE_TOKENS;
                break;
            case 'tool-result':
                total += countMessageTokens(block.content, counter);
                break;
            case 'reasoning':
                total += counter(block.text);
                break;
            case 'tool-call':
                total += counter(block.name) + counter(block.arguments);
                break;
        }
    }
    return total;
}
/**
 * Estimate the input-token cost of a request with a real tokenizer.
 *
 * @param options - the harness request.
 * @param counter - a `TokenCounter` bound to the right encoding for the
 *   model. Pass `counterFor(encoding)` once and reuse per request.
 */
export function estimateInputTokens(options, counter) {
    let total = 0;
    if (options.system !== undefined) {
        total += counter(options.system);
    }
    for (const message of options.messages) {
        total += countMessageTokens(message.content, counter);
    }
    if (options.tools !== undefined) {
        for (const tool of options.tools) {
            const json = JSON.stringify({
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.parameters,
            });
            total += counter(json);
        }
    }
    return total;
}
/**
 * Decide whether a request would overflow the context window.
 *
 * @param options - the harness request.
 * @param counter - a `TokenCounter` bound to the model's encoding.
 * @param contextWindow - the model's context window.
 * @param outputCap - the per-request output cap.
 * @returns the estimated input tokens if the request fits, or a
 *   `fits: false` summary if it would overflow.
 */
export function fitsContext(options, counter, contextWindow, outputCap) {
    const inputTokens = estimateInputTokens(options, counter);
    const wouldNeed = inputTokens + outputCap;
    if (wouldNeed > contextWindow) {
        return { fits: false, inputTokens, wouldNeed };
    }
    return { inputTokens, fits: true };
}
