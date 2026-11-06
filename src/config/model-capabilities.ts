/**
 * Model capability resolution shared by both LocalForge adapters.
 *
 * LM Studio's native `/api/v0/models` listing reports `type: 'llm' | 'vlm'`,
 * which the discovery layer maps to `vision: boolean`. `resolveModel()` has
 * always used that hint, but request serialization must use the same policy:
 * otherwise a text-only model is advertised as text-only to the harness while
 * the wire request still carries `image_url` / `image` blocks.
 *
 * Precedence:
 *  1. the user's `models[].vision` override, when present;
 *  2. the discovered capability;
 *  3. permissive default (`true`) — a server without the native endpoint must
 *     keep its historical behavior.
 */
export interface VisionOverride {
  vision?: boolean
}

export interface DiscoveredVision {
  vision?: boolean
}

/** True when the model can receive image content. */
export function modelSupportsVision(
  override: VisionOverride | undefined,
  discovered: DiscoveredVision | undefined,
): boolean {
  return (override?.vision ?? discovered?.vision) !== false
}
