/**
 * Real token counting via `gpt-tokenizer` (MIT, pure JS).
 *
 * `gpt-tokenizer` ships the BPE tables compiled into JavaScript; no
 * WASM, no native bindings, no startup cost. Encoding selection is
 * driven by the model id: GPT-4o / o-series map to `o200k_base`,
 * GPT-4 / GPT-3.5 / most modern open-source models (Qwen, Llama-3,
 * Mistral) map to `cl100k_base`. The mapping is a static lookup; a
 * user can override with `tokenizer.encoding` in the config.
 *
 * The pre-flight estimate (`token-estimator.ts`) used a `chars / 3.5`
 * heuristic because a portable tokenizer that worked across model
 * families didn't exist. With `gpt-tokenizer` it does. The
 * `tokenize()` function returns a real count; the heuristic is kept
 * as a fallback when the model id is unknown and the user hasn't set
 * an explicit encoding.
 */

import {
  encode,
  decode,
  isWithinTokenLimit,
} from 'gpt-tokenizer'
import type {
  GptTokenizerEncoder,
  TikEncoding,
} from 'gpt-tokenizer'

/** The encodings `gpt-tokenizer` ships. */
export type SupportedEncoding =
  | 'o200k_base'
  | 'cl100k_base'
  | 'p50k_base'
  | 'p50k_edit'
  | 'r50k_base'

const ENCODINGS: Readonly<Record<SupportedEncoding, GptTokenizerEncoder>> = {
  o200k_base: encode,
  cl100k_base: encode,
  p50k_base: encode,
  p50k_edit: encode,
  r50k_base: encode,
} as const

/** gpt-tokenizer type aliases (avoid importing the full type surface). */
type _Encoder = typeof encode
type _Decoder = typeof decode

/**
 * Map a model id to a `gpt-tokenizer` encoding. The pattern table
 * covers the families `dsh-localforge` is most likely to see on a
 * local LM Studio / Ollama setup.
 */
function pickEncodingForModel(modelId: string): SupportedEncoding {
  const m = modelId.toLowerCase()
  // OpenAI o-series, gpt-4o family → o200k_base
  if (/\bgpt-4o\b/.test(m)) return 'o200k_base'
  if (/\bo[1-9]\b/.test(m)) return 'o200k_base'
  if (/\bgpt-5\b/.test(m)) return 'o200k_base'
  // Most modern open-source models (Qwen, Llama-3, Mistral, DeepSeek)
  // use a cl100k-base-compatible tokenizer or one close enough that
  // cl100k_base is a safe approximation.
  return 'cl100k_base'
}

/** A `gpt-tokenizer` encoder bound to one encoding. */
export interface Tokenizer {
  readonly encoding: SupportedEncoding
  /** Count tokens in `text`. */
  count(text: string): number
  /** Count tokens in each item of `texts`, in order. */
  countMany(texts: readonly string[]): number[]
  /** Encode `text` to token ids. */
  encode(text: string): readonly number[]
  /** Decode token ids back to text. */
  decode(tokens: readonly number[]): string
  /** True when `text` is within `limit` tokens. */
  fits(text: string, limit: number): boolean
}

const encoderCache = new Map<SupportedEncoding, GptTokenizerEncoder>()

/** Resolve (and memoize) a `gpt-tokenizer` encoder for one encoding. */
function getEncoder(encoding: SupportedEncoding): GptTokenizerEncoder {
  const cached = encoderCache.get(encoding)
  if (cached !== undefined) return cached
  const enc = ENCODINGS[encoding]
  encoderCache.set(encoding, enc)
  return enc
}

/**
 * Build a tokenizer for a given model id, honoring an explicit
 * `encoding` override from the config when supplied.
 *
 * @param modelId - the wire model id (e.g. `qwen/qwen3-8b`).
 * @param explicit - an explicit encoding override from
 *   `tokenizer.encoding`; when undefined, the model-id heuristic
 *   decides.
 */
export function createTokenizer(
  modelId: string,
  explicit?: SupportedEncoding,
): Tokenizer {
  const encoding = explicit ?? pickEncodingForModel(modelId)
  const enc = getEncoder(encoding)
  return {
    encoding,
    count(text) { return enc(text).length },
    countMany(texts) { return texts.map(t => enc(t).length) },
    encode(text) { return enc(text) },
    decode(tokens) { return decode(tokens as number[]) },
    fits(text, limit) { return isWithinTokenLimit(text, limit, enc) },
  }
}

/** Estimate the tokenizer-accurate input-token cost of a request. */
export type TokenCounter = (text: string) => number

/**
 * Cheap path: a single counter for one encoding, used when the caller
 * knows the model up-front (the common case in token pre-flight).
 *
 * @param encoding - the encoding to bind to.
 */
export function counterFor(encoding: SupportedEncoding): TokenCounter {
  const enc = getEncoder(encoding)
  return (text: string) => enc(text).length
}

/** Expose the heuristic for tests and consumers. */
export const _internal = { pickEncodingForModel }

/** Re-export the encoder type so tests can import it consistently. */
export type { GptTokenizerEncoder, TikEncoding }