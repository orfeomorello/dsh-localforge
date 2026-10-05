/**
 * A minimal LM Studio + Anthropic-compatible mock for integration tests.
 *
 * Implements:
 *  - `GET /v1/models` (OpenAI-compat)
 *  - `GET /api/v0/models` (LM Studio native)
 *  - `POST /api/v0/models/{id}/load`
 *  - `POST /v1/chat/completions` (OpenAI SSE)
 *  - `POST /v1/messages` (Anthropic SSE; x-api-key auth)
 *
 * The mock holds an in-memory catalog. It supports loading/unloading
 * models on demand. Auth is enforced when an apiKey is set.
 */

import http from 'node:http'
import { AddressInfo } from 'node:net'

interface MockModel {
  id: string
  type?: 'llm' | 'vlm'
  state: 'loaded' | 'not-loaded'
  loaded_context_length?: number
  max_context_length: number
}

export interface MockLmStudioOptions {
  apiKey?: string
  models?: MockModel[]
}

export class MockLmStudio {
  private server: http.Server
  private readonly state: { models: MockModel[]; apiKey?: string }

  constructor(opts: MockLmStudioOptions = {}) {
    this.state = {
      models: opts.models ?? [],
      ...opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {},
    }
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  /** Start listening on a random free port; resolves with the base URL. */
  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address() as AddressInfo
    return `http://127.0.0.1:${addr.port}`
  }

  /** Stop the server. */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close(err => err ? reject(err) : resolve()))
  }

  /** Mark a model loaded. Used to simulate successful auto-load. */
  loadModel(id: string): void {
    const m = this.state.models.find(x => x.id === id)
    if (m) m.state = 'loaded'
  }

  /** Mark a model unloaded. */
  unloadModel(id: string): void {
    const m = this.state.models.find(x => x.id === id)
    if (m) m.state = 'not-loaded'
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.state.apiKey !== undefined) {
      const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? ''
      if (auth !== `Bearer ${this.state.apiKey}` && auth !== this.state.apiKey) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
    }
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/v1/models') return this.listCompat(res)
    if (req.method === 'GET' && url === '/api/v0/models') return this.listNative(res)
    if (req.method === 'POST' && url.startsWith('/api/v0/models/') && url.endsWith('/load')) {
      return this.loadEndpoint(url, res)
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      return this.streamOpenAIChat(req, res)
    }
    if (req.method === 'POST' && url === '/v1/messages') {
      return this.streamAnthropicMessages(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  }

  private listCompat(res: http.ServerResponse): void {
    const data = this.state.models.map(m => ({ id: m.id }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data }))
  }

  private listNative(res: http.ServerResponse): void {
    const data = this.state.models.map(m => ({
      id: m.id,
      ...m.type !== undefined ? { type: m.type } : {},
      state: m.state,
      ...m.loaded_context_length !== undefined ? { loaded_context_length: m.loaded_context_length } : {},
      max_context_length: m.max_context_length,
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data }))
  }

  private loadEndpoint(url: string, res: http.ServerResponse): void {
    const id = decodeURIComponent(url.split('/').slice(-2, -1)[0] ?? '')
    const m = this.state.models.find(x => x.id === id)
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `unknown model ${id}` } }))
      return
    }
    m.state = 'loaded'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  private streamOpenAIChat(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.accumulateBody(req, body => {
      let parsed: { model?: string } = {}
      try { parsed = JSON.parse(body) } catch {
        res.writeHead(400); res.end(); return
      }
      const model = parsed.model ?? ''
      if (!this.state.models.find(m => m.id === model)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `unknown model ${model}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunks: string[] = [
        JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', created: 0, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
        JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', created: 0, model,
          choices: [{ index: 0, delta: { content: 'mock reply' }, finish_reason: null }] }),
        JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', created: 0, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
        '[DONE]',
      ]
      this.streamSse(res, chunks)
    })
  }

  private streamAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.accumulateBody(req, body => {
      let parsed: { model?: string } = {}
      try { parsed = JSON.parse(body) } catch {
        res.writeHead(400); res.end(); return
      }
      const model = parsed.model ?? ''
      if (!this.state.models.find(m => m.id === model)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'not_found', message: `unknown model ${model}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const events: string[] = [
        this.sseEvent('message_start', { type: 'message_start', message: {
          id: 'msg_1', type: 'message', role: 'assistant', content: [], model,
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
        } }),
        this.sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        this.sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mock anthropic' } }),
        this.sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
        this.sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
        this.sseEvent('message_stop', { type: 'message_stop' }),
      ]
      this.streamSse(res, events)
    })
  }

  private sseEvent(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  }

  /** Stream a list of pre-formatted SSE messages. */
  private streamSse(res: http.ServerResponse, messages: readonly string[]): void {
    let i = 0
    const tick = (): void => {
      if (i >= messages.length) { res.end(); return }
      res.write(messages[i] ?? '')
      i++
      setImmediate(tick)
    }
    tick()
  }

  private accumulateBody(req: http.IncomingMessage, next: (body: string) => void): void {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => next(body))
  }
}