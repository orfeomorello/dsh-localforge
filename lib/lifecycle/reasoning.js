/**
 * Reasoning budget control for thinking-capable models.
 *
 * Two paths:
 *
 *  1. If the model supports the `reasoning_effort` parameter (Qwen3,
 *     GPT-OSS, and a growing list), the budget is mapped to one of
 *     `low` / `medium` / `high` and set on the request body. The
 *     server is the source of truth for what the cap means.
 *  2. Otherwise, the budget is communicated as a system reminder
 *     that asks the model to stop reasoning after the budget. The
 *     model is not bound to honor it, but most well-trained
 *     instruct models do.
 *
 * The model-id pattern match is a static lookup, no network call. If
 * a server implements `reasoning_effort` for a model we don't
 * recognize, the user can still set the parameter manually on the
 * request and the adapter will pass it through.
 */
/** Model id patterns that accept `reasoning_effort` natively. */
const EFFORT_AWARE_PATTERNS = [
    /qwen3/i,
    /gpt-oss/i,
    /deepseek-r1/i,
];
/**
 * Map a numeric budget to one of the discrete `reasoning_effort` values.
 * The thresholds are arbitrary starting points; users can override.
 */
function budgetToEffort(budget) {
    if (budget <= 2_048)
        return 'low';
    if (budget <= 8_192)
        return 'medium';
    return 'high';
}
/**
 * Detect whether a model id suggests native `reasoning_effort` support.
 */
export function supportsReasoningEffort(modelId) {
    return EFFORT_AWARE_PATTERNS.some(p => p.test(modelId));
}
/**
 * Apply a reasoning budget to a wire request.
 *
 * @param body - the OpenAI chat-completions request body.
 * @param budget - the maximum reasoning tokens before the final answer.
 *   Zero or negative budgets are ignored.
 * @returns the body with the budget applied (or unchanged).
 */
export function applyReasoningBudget(body, budget) {
    if (budget === undefined || budget <= 0)
        return body;
    if (supportsReasoningEffort(body.model)) {
        return { ...body, reasoning_effort: budgetToEffort(budget) };
    }
    // Fallback: append a system reminder that asks the model to stop
    // reasoning after the budget. We append (not prepend) so the user's
    // original system prompt keeps priority.
    return {
        ...body,
        messages: [
            ...body.messages,
            {
                role: 'system',
                content: `Stop internal reasoning once you have used ${budget} tokens of thought.`
                    + ' Switch directly to producing the final answer.',
            },
        ],
    };
}
