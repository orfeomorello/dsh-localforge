/**
 * Sampling presets: a named bundle of temperature / top_p / top_k / penalties
 * that matches a common task shape. The plugin's chat-completions adapter
 * applies the preset the model's override names (or the request supplies),
 * without overriding any field the caller already set.
 *
 * The presets are deliberately conservative — they're starting points, not
 * gospel. A power user can always specify `temperature`, `top_p`, etc.
 * directly on the request.
 */
export const SamplingPresets = {
    code: { temperature: 0.2, top_p: 0.95, top_k: 40, frequency_penalty: 0, presence_penalty: 0 },
    chat: { temperature: 0.7, top_p: 0.9, top_k: 50, frequency_penalty: 0, presence_penalty: 0 },
    creative: { temperature: 1.0, top_p: 0.95, top_k: 80, frequency_penalty: 0.1, presence_penalty: 0.1 },
    precise: { temperature: 0.1, top_p: 0.8, top_k: 20, frequency_penalty: 0, presence_penalty: 0 },
};
/**
 * Apply a named preset to a sampling params bag, never overriding fields the
 * caller already set. The preset name is ignored if undefined.
 */
export function applyPreset(params, preset) {
    if (!preset)
        return params;
    const p = SamplingPresets[preset];
    return {
        ...p,
        ...params,
    };
}
