/**
 * Schemastery schemas for the `llm-localforge` settings section.
 *
 * Schemastery powers both the runtime validation (when the user writes
 * settings) and the inferred TypeScript types (via `z.infer`). Every
 * field is optional and has a default so a user can write an empty
 * section and the plugin still works against the local default server.
 */

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'

const PRESET = z.enum(['code', 'chat', 'creative', 'precise'])
const ENCODING = z.enum(['o200k_base', 'cl100k_base', 'p50k_base', 'p50k_edit', 'r50k_base'])

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

export const ConfigSchema = z.object({
  defaultConnection: Connection.default({}),
  anthropicConnection: AnthropicConnection.default({}),
  defaultContextWindow: z.number().min(1).default(32_768),
  defaultMaxTokens: z.number().min(1).default(4_096),
  models: z.array(ModelOverride).default([]),
  /** Tokenizer settings. */
  tokenizer: Tokenizer.default({}),
  metrics: z.object({
    enabled: z.boolean().default(true),
    prefix: z.string().default('dsh_localforge'),
  }).default({}),
  healthCheck: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().min(1_000).max(600_000).default(15_000),
  }).default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type ConnectionConfig = z.infer<typeof Connection>
export type AnthropicConnectionConfig = z.infer<typeof AnthropicConnection>
export type ModelOverrideConfig = z.infer<typeof ModelOverride>
export type TokenizerConfig = z.infer<typeof Tokenizer>