/**
 * Schemastery schemas for the `llm-localforge` settings section.
 *
 * Schemastery powers both the runtime validation (when the user writes
 * settings) and the inferred TypeScript types (via `z.TypeT`). Every
 * field is optional and has a default so a user can write an empty
 * section and the plugin still works against the local default server.
 */

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'

const PRESET = z.union([
  z.const('code'),
  z.const('chat'),
  z.const('creative'),
  z.const('precise'),
])
const ENCODING = z.union([
  z.const('o200k_base'),
  z.const('cl100k_base'),
  z.const('p50k_base'),
  z.const('p50k_edit'),
  z.const('r50k_base'),
])

const Connection = z.object({
  baseURL: z.string().default('http://localhost:1234/v1'),
  apiKeyEnv: z.string().role('credential-ref'),
  requestTimeoutMs: z.number().min(1).max(600_000).default(120_000),
  streamIdleTimeoutMs: z.number().min(1).max(600_000).default(300_000),
  discoveryTimeoutMs: z.number().min(1).max(60_000).default(10_000),
  listingCacheMs: z.number().min(0).max(3_600_000).default(30_000),
  maxConcurrentPerModel: z.number().min(1).max(16).default(1),
  retryPolicy: RetryPolicySchema,
})

/** Connection settings for the Anthropic-compatible adapter. */
const AnthropicConnection = z.object({
  baseURL: z.string().default('http://localhost:1234'),
  apiKeyEnv: z.string().role('credential-ref'),
  requestTimeoutMs: z.number().min(1).max(600_000).default(120_000),
  streamIdleTimeoutMs: z.number().min(1).max(600_000).default(300_000),
  discoveryTimeoutMs: z.number().min(1).max(60_000).default(10_000),
  listingCacheMs: z.number().min(0).max(3_600_000).default(30_000),
  maxConcurrentPerModel: z.number().min(1).max(16).default(1),
  retryPolicy: RetryPolicySchema,
})

const ModelOverride = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().min(1),
  maxTokens: z.number().min(1),
  vision: z.boolean(),
  preset: PRESET,
  reasoningBudget: z.number().min(0),
  fallback: z.array(z.string()).default([]),
})

/** Tokenizer settings. */
const Tokenizer = z.object({
  /** Explicit encoding override; when omitted, the model-id heuristic decides. */
  encoding: ENCODING,
})

/** Document and Vision (PDF/OCR/image) expansion settings. */
const Documents = z.object({
  /** Automatically extract text and Vision images from attached PDFs and local image/PDF paths. */
  enabled: z.boolean().default(true),
  /** Maximum file size in bytes to read when expanding PDFs or images (default: 32 MiB). */
  maxFileBytes: z.number().min(1_024).max(268_435_456).default(33_554_432),
  /** Maximum number of embedded/page images to attach per PDF for Vision OCR. */
  maxPdfImages: z.number().min(0).max(32).default(8),
  /** Maximum characters of text to extract per PDF. */
  maxPdfTextChars: z.number().min(1_000).max(1_000_000).default(100_000),
})

export const ConfigSchema = z.object({
  defaultConnection: Connection.default({} as never),
  anthropicConnection: AnthropicConnection.default({} as never),
  defaultContextWindow: z.number().min(1).default(32_768),
  defaultMaxTokens: z.number().min(1).default(4_096),
  models: z.array(ModelOverride).default([]),
  /** Tokenizer settings. */
  tokenizer: Tokenizer.default({} as never),
  /** PDF and local image Vision expansion settings. */
  documents: Documents.default({} as never),
  metrics: z.object({
    enabled: z.boolean().default(true),
    prefix: z.string().default('dsh_localforge'),
  }).default({} as never),
  healthCheck: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().min(1_000).max(600_000).default(15_000),
  }).default({} as never),
})

export type Config = Schemastery.TypeT<typeof ConfigSchema>
export type ConnectionConfig = Schemastery.TypeT<typeof Connection>
export type AnthropicConnectionConfig = Schemastery.TypeT<typeof AnthropicConnection>
export type ModelOverrideConfig = Schemastery.TypeT<typeof ModelOverride>
export type TokenizerConfig = Schemastery.TypeT<typeof Tokenizer>
export type DocumentsConfig = Schemastery.TypeT<typeof Documents>
