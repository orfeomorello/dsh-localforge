import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import {
  classifyDocumentPath,
  detectImageMediaType,
  extractPdfPureJs,
  extractPdfFile,
  extractImageFile,
  expandTextWithLocalDocuments,
  inspectLocalPathOrDirectory,
} from '../../src/document/pdf-and-image.ts'
import { serializeRequest } from '../../src/streaming/serialize.ts'
import { serializeAnthropicRequest } from '../../src/streaming/anthropic-serialize.ts'
import { ChatCompletionsAdapter } from '../../src/adapter/chat-completions.ts'
import { AnthropicMessagesAdapter } from '../../src/adapter/anthropic-messages.ts'
import { ListingCache } from '../../src/discovery/cache.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * Build a minimal valid PDF buffer containing a FlateDecode text stream
 * and an optional embedded DCTDecode (JPEG) image stream.
 */
function buildSamplePdfBuffer(text: string, includeEmbeddedJpeg = false): Buffer {
  const contentStream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const compressed = zlib.deflateSync(Buffer.from(contentStream, 'latin1'))

  // Minimal 1x1 JPEG bytes (SOI + APP0 + EOI header markers)
  const fakeJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ])

  const parts: Buffer[] = []
  const pushStr = (s: string) => parts.push(Buffer.from(s, 'latin1'))

  pushStr('%PDF-1.4\n')
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  pushStr('3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n')
  pushStr(`4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`)
  parts.push(compressed)
  pushStr('\nendstream\nendobj\n')

  if (includeEmbeddedJpeg) {
    pushStr(
      `5 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${fakeJpeg.length} >>\nstream\n`,
    )
    parts.push(fakeJpeg)
    pushStr('\nendstream\nendobj\n')
  }

  pushStr('%%EOF\n')
  return Buffer.concat(parts)
}

/** Minimal 1x1 transparent PNG buffer. */
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe('pdf-and-image document & Vision processor', () => {
  let tmpDir: string
  let samplePdfPath: string
  let scannedPdfPath: string
  let samplePngPath: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localforge-doc-test-'))
    samplePdfPath = path.join(tmpDir, 'fattura-2026.pdf')
    scannedPdfPath = path.join(tmpDir, 'scansione-ocr.pdf')
    samplePngPath = path.join(tmpDir, 'diagramma.png')

    await fs.writeFile(samplePdfPath, buildSamplePdfBuffer('Fattura N. 42 - Totale Euro 1250.00', true))
    await fs.writeFile(scannedPdfPath, buildSamplePdfBuffer('', true))
    await fs.writeFile(samplePngPath, SAMPLE_PNG)
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('classifies PDF and image extensions accurately', () => {
    expect(classifyDocumentPath('/tmp/doc.PDF')).toEqual({ kind: 'pdf' })
    expect(classifyDocumentPath('C:\\folder\\photo.png')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(classifyDocumentPath('C:\\folder\\photo.jpg')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(classifyDocumentPath('C:\\folder\\photo.webp')).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(classifyDocumentPath('C:\\folder\\notes.txt')).toBeUndefined()
  })

  it('detects image mediaType from magic bytes', () => {
    expect(detectImageMediaType(SAMPLE_PNG)).toBe('image/png')
    expect(detectImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  })

  it('extracts text and embedded JPEG images from PDF via pure-JS parser', () => {
    const buf = buildSamplePdfBuffer('Hello LocalForge PDF Vision!', true)
    const res = extractPdfPureJs(buf)
    expect(res.pageCount).toBe(1)
    expect(res.text).toContain('Hello LocalForge PDF Vision!')
    expect(res.images.length).toBe(1)
    expect(res.images[0]?.mediaType).toBe('image/jpeg')
  })

  it('extracts PDF file from disk with text and embedded images', async () => {
    const res = await extractPdfFile(samplePdfPath)
    expect(res.kind).toBe('pdf')
    expect(res.fileName).toBe('fattura-2026.pdf')
    expect(res.textSummary).toContain('Fattura N. 42 - Totale Euro 1250.00')
    expect(res.images.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts scanned PDF without text layer and attaches embedded OCR image', async () => {
    const res = await extractPdfFile(scannedPdfPath)
    expect(res.kind).toBe('pdf')
    expect(res.textSummary).toContain('Vision OCR analysis')
    expect(res.images.length).toBe(1)
    expect(res.images[0]?.mediaType).toBe('image/jpeg')
  })

  it('extracts local PNG image file into base64 Vision payload', async () => {
    const res = await extractImageFile(samplePngPath, 'image/png')
    expect(res.kind).toBe('image')
    expect(res.images.length).toBe(1)
    expect(res.images[0]?.mediaType).toBe('image/png')
    expect(res.images[0]?.base64).toBe(SAMPLE_PNG.toString('base64'))
  })

  it('expands dsh fileHandleText for attached PDFs and images automatically', async () => {
    const handlePrompt = [
      'Leggi questi file allegati:',
      `[File "fattura-2026.pdf" (512 bytes, sha256:12345678): verbatim read-only copy saved at "${samplePdfPath}". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it.]`,
      `[File "diagramma.png" (68 bytes, sha256:87654321): verbatim read-only copy saved at "${samplePngPath}". Read that path with your file tools when its contents are needed.]`,
    ].join('\n')

    const expanded = await expandTextWithLocalDocuments(handlePrompt)
    expect(expanded.text).toContain('Fattura N. 42 - Totale Euro 1250.00')
    expect(expanded.text).toContain('LocalForge Vision Image Attached: "diagramma.png"')
    expect(expanded.images.length).toBe(2)
  })

  it('decodes JSON-escaped Windows paths exactly as dsh-llm fileHandleText emits them', async () => {
    // Mirror dsh-llm's content.js: `File ${JSON.stringify(name)} (...)` and
    // `saved at ${JSON.stringify(readonlyPath)}` — on Windows backslashes are doubled.
    const handle = `[File ${JSON.stringify('fattura-2026.pdf')} (512 bytes, sha256:12345678): verbatim read-only copy saved at ${JSON.stringify(samplePdfPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it.]`
    const expanded = await expandTextWithLocalDocuments(handle)
    expect(expanded.text).toContain('Fattura N. 42 - Totale Euro 1250.00')
    expect(expanded.images.length).toBeGreaterThanOrEqual(1)
  })

  it('expands a local directory path when referenced in prompt or inspectLocalPathOrDirectory', async () => {
    const dirRes = await inspectLocalPathOrDirectory(tmpDir)
    expect(dirRes.text).toContain('fattura-2026.pdf')
    expect(dirRes.text).toContain('Fattura N. 42 - Totale Euro 1250.00')
    expect(dirRes.text).toContain('diagramma.png')
    expect(dirRes.images.length).toBeGreaterThanOrEqual(2)

    const promptWithDir = `Puoi analizzare i file nella cartella "${tmpDir}"?`
    const expandedPrompt = await expandTextWithLocalDocuments(promptWithDir)
    expect(expandedPrompt.text).toContain('LocalForge Directory Scan')
    expect(expandedPrompt.text).toContain('Fattura N. 42 - Totale Euro 1250.00')
    expect(expandedPrompt.images.length).toBeGreaterThanOrEqual(2)
  })

  it('serializes attached PDF and image into OpenAI WireRequest with text and image_url parts', async () => {
    const opts = {
      provider: 'localforge',
      model: 'qwen/qwen2.5-vl-7b',
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `[File "fattura-2026.pdf" (512 bytes, sha256:12345678): verbatim read-only copy saved at "${samplePdfPath}".]`,
        }],
      }],
    } as unknown as GenerateOptions

    const wire = await serializeRequest(opts)
    const userMsg = wire.messages[0]
    expect(userMsg?.role).toBe('user')
    if (userMsg?.role === 'user') {
      expect(Array.isArray(userMsg.content)).toBe(true)
      if (Array.isArray(userMsg.content)) {
        const textPart = userMsg.content.find(p => p.type === 'text')
        const imgPart = userMsg.content.find(p => p.type === 'image_url')
        expect(textPart?.type === 'text' && textPart.text).toContain('Fattura N. 42 - Totale Euro 1250.00')
        expect(imgPart?.type === 'image_url' && imgPart.image_url.url).toMatch(/^data:image\/jpeg;base64,/)
      }
    }
  })

  it('serializes attached PDF and image into AnthropicRequest with text and base64 image blocks', async () => {
    const opts = {
      provider: 'localforge-anthropic',
      model: 'qwen/qwen2.5-vl-7b',
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `[File "diagramma.png" (68 bytes, sha256:87654321): verbatim read-only copy saved at "${samplePngPath}".]`,
        }],
      }],
    } as unknown as GenerateOptions

    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    const userMsg = body.messages[0]
    expect(userMsg?.role).toBe('user')
    if (userMsg?.role === 'user') {
      const imgBlock = userMsg.content.find(b => b.type === 'image')
      expect(imgBlock).toBeDefined()
      if (imgBlock?.type === 'image') {
        expect(imgBlock.source.media_type).toBe('image/png')
        expect(imgBlock.source.data).toBe(SAMPLE_PNG.toString('base64'))
      }
    }
  })
})

describe('Adapter resolveModel() Vision & context capabilities', () => {
  const dummyConn = () => ({
    baseURL: 'http://localhost:1234/v1',
    requestTimeoutMs: 10_000,
    streamIdleTimeoutMs: 30_000,
    discoveryTimeoutMs: 5_000,
    listingCacheMs: 1_000,
    maxConcurrentPerModel: 1,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
    defaultContextWindow: 65_536,
    defaultMaxTokens: 8_192,
  })

  it('ChatCompletionsAdapter.resolveModel advertises text+image modalities and contextWindow', async () => {
    const cache = new ListingCache(
      async () => [{ id: 'qwen/qwen2.5-vl-7b', state: 'loaded', contextWindow: 32_768, vision: true }],
      () => 1_000,
    )
    const adapter = new ChatCompletionsAdapter({
      resolveConn: dummyConn,
      resolveApiKey: async () => 'lm-studio',
      cache,
    })

    const resolved = await adapter.resolveModel('localforge', 'qwen/qwen2.5-vl-7b')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.context?.contextWindow).toBe(32_768)
    expect(resolved.defaultMaxTokens).toBe(8_192)
  })

  it('AnthropicMessagesAdapter.resolveModel respects vision:false override', async () => {
    const cache = new ListingCache(
      async () => [{ id: 'text-only-model', state: 'loaded', contextWindow: 16_384, vision: true }],
      () => 1_000,
    )
    const adapter = new AnthropicMessagesAdapter({
      resolveConn: dummyConn,
      resolveApiKey: async () => 'lm-studio',
      cache,
      modelOverrides: [{ id: 'text-only-model', vision: false, contextWindow: 49_152 }],
    })

    const resolved = await adapter.resolveModel('localforge-anthropic', 'text-only-model')
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.context?.contextWindow).toBe(49_152)
  })
})
