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
export {};
