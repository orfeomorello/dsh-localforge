/**
 * End-to-end test of the chat-completions adapter against a mock LM Studio.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ChatCompletionsAdapter } from '../../src/adapter/chat-completions.ts'
import { ListingCache } from '../../src/discovery/cache.ts'
import { fetchListing } from '../../src/discovery/fetcher.ts'
import { MockLmStudio } from './mock-lmstudio.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

describe('ChatCompletionsAdapter (integration)', () => {
  let mock: MockLmStudio
  let baseURL: string
  let adapter: ChatCompletionsAdapter

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
    baseURL = `${serverUrl}/v1`
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
    adapter = new ChatCompletionsAdapter({
      resolveConn: conn,
      resolveApiKey: async () => 'lm-studio',
      cache,
    })
  })

  afterAll(async () => { await mock.close() })

  it('lists models from the native endpoint', async () => {
    const models = await adapter.listModels('localforge')
    expect(models.length).toBe(1)
    expect(models[0]?.id).toBe('qwen/qwen3-8b')
  })

  it('streams a chat completion end-to-end', async () => {
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
    expect(chunks.join('')).toBe('mock reply')
    expect(finish?.kind).toBe('stop')
  })

  it('throws OVERFLOW when context window is exceeded', async () => {
    const opts: GenerateOptions = {
      model: 'qwen/qwen3-8b',
      maxTokens: 1000,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'a'.repeat(100_000) }],
      }],
    }
    await expect(async () => {
      for await (const _c of adapter.stream(opts)) { /* drain */ }
    }).rejects.toThrow(/context window/i)
  })
})