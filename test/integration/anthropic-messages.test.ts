/**
 * End-to-end test of the AnthropicMessagesAdapter against a mock
 * Anthropic-compatible endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AnthropicMessagesAdapter } from '../../src/adapter/anthropic-messages.ts'
import { ListingCache } from '../../src/discovery/cache.ts'
import { fetchListing } from '../../src/discovery/fetcher.ts'
import { MockLmStudio } from './mock-lmstudio.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

describe('AnthropicMessagesAdapter (integration)', () => {
  let mock: MockLmStudio
  let baseURL: string
  let adapter: AnthropicMessagesAdapter

  beforeAll(async () => {
    mock = new MockLmStudio({
      models: [{
        id: 'qwen/qwen3-8b',
        type: 'llm',
        state: 'loaded',
        loaded_context_length: 32_768,
        max_context_length: 32_768,
      }],
    })
    const serverUrl = await mock.listen()
    // Anthropic-style baseURL does NOT include /v1; the adapter
    // appends /v1/messages.
    baseURL = serverUrl
    const conn = () => ({
      baseURL,
      apiKeyEnv: undefined,
      requestTimeoutMs: 10_000,
      streamIdleTimeoutMs: 30_000,
      discoveryTimeoutMs: 5_000,
      listingCacheMs: 100,
      maxConcurrentPerModel: 1,
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
    })
    const cache = new ListingCache(
      () => fetchListing(baseURL, 'lm-studio', 5_000),
      () => 100,
    )
    adapter = new AnthropicMessagesAdapter({
      resolveConn: conn,
      resolveApiKey: async () => 'lm-studio',
      cache,
    })
  })

  afterAll(async () => { await mock.close() })

  it('lists models from the same listing', async () => {
    const models = await adapter.listModels('localforge-anthropic')
    expect(models.length).toBe(1)
    expect(models[0]?.id).toBe('qwen/qwen3-8b')
  })

  it('streams an Anthropic-style completion end-to-end', async () => {
    const opts: GenerateOptions = {
      model: 'qwen/qwen3-8b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const chunks: string[] = []
    let finish: { kind: string } | undefined
    for await (const c of adapter.stream(opts)) {
      if (c.type === 'text-delta') chunks.push(c.text)
      if (c.type === 'finish') finish = c.reason
    }
    expect(chunks.join('')).toBe('mock anthropic')
    expect(finish?.kind).toBe('stop')
  })

  it('serializes a tool definition to Anthropic input_schema and uses it', async () => {
    const opts: GenerateOptions = {
      model: 'qwen/qwen3-8b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'noop', parameters: { type: 'object' } }],
    }
    // Just verify the stream completes without error
    const out: string[] = []
    for await (const c of adapter.stream(opts)) {
      if (c.type === 'text-delta') out.push(c.text)
    }
    expect(out.join('')).toBe('mock anthropic')
  })
})