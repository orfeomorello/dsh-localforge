import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  buildReadDocumentTool,
  readDocumentForTool,
  READ_DOCUMENT_TOOL_NAME,
} from '../../src/document/tool.ts'
import { serializeRequest } from '../../src/streaming/serialize.ts'
import { serializeAnthropicRequest } from '../../src/streaming/anthropic-serialize.ts'

function buildPdf(text: string): Buffer {
  const content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'latin1'))
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n', 'latin1'),
    Buffer.from(`2 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    content,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from(`3 0 obj\n<< /Subtype /Image /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'),
    jpeg,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe('localforge_read_document tool', () => {
  let dir: string
  let pdfPath: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localforge tool test '))
    pdfPath = path.join(dir, 'contratto.pdf')
    await fs.writeFile(pdfPath, buildPdf('Contratto di locazione 2026'))
    await fs.writeFile(path.join(dir, 'foto.png'), PNG)
    await fs.writeFile(path.join(dir, 'note.txt'), 'ignored')
  })

  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('exposes a valid raw JSON-Schema tool definition', () => {
    const def = buildReadDocumentTool(() => undefined) as {
      name: string; description: string; parameters: { required: string[] }
      output: { render: (a: unknown, v: string) => unknown }
    }
    expect(def.name).toBe(READ_DOCUMENT_TOOL_NAME)
    expect(def.description).toMatch(/instead of read_file/)
    expect(def.parameters.required).toEqual(['path'])
    expect(def.output.render({}, 'x')).toEqual([{ type: 'text', text: 'x' }])
  })

  it('reads a single PDF and emits a Vision attach marker', async () => {
    const out = await readDocumentForTool(pdfPath)
    expect(out).toContain('Contratto di locazione 2026')
    expect(out).toContain(`[LocalForge Vision Attach: ${JSON.stringify(pdfPath)}]`)
  })

  it('reads every supported file in a folder (path with spaces) and skips others', async () => {
    const def = buildReadDocumentTool(() => undefined) as {
      execute: (a: { path: string }, e: unknown) => Promise<string>
    }
    const out = await def.execute({ path: dir }, {})
    expect(out).toContain('contratto.pdf')
    expect(out).toContain('foto.png')
    expect(out).not.toContain('note.txt')
  })

  it('throws model-readable errors for missing paths and unsupported files', async () => {
    await expect(readDocumentForTool(path.join(dir, 'missing.pdf'))).rejects.toThrow(/path not found/)
    await expect(readDocumentForTool(path.join(dir, 'note.txt'))).rejects.toThrow(/unsupported file type/)
  })

  it('serializers attach marker images to tool results without duplicating text', async () => {
    const toolText = await readDocumentForTool(pdfPath)
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId('c1'), name: READ_DOCUMENT_TOOL_NAME, arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: toolText }] }] },
    ]
    const opts = { provider: 'localforge', model: 'vl', messages } as unknown as GenerateOptions

    const wire = await serializeRequest(opts)
    const toolMsg = wire.messages.find(m => m.role === 'tool')
    expect(toolMsg?.role === 'tool' && toolMsg.content.split('Contratto di locazione 2026').length).toBe(2)
    const userMsg = wire.messages.find(m => m.role === 'user')
    expect(userMsg?.role === 'user' && Array.isArray(userMsg.content)
      && userMsg.content.some(p => p.type === 'image_url')).toBe(true)

    const anth = await serializeAnthropicRequest(opts, undefined, 1024)
    const user = anth.messages.find(m => m.role === 'user')
    expect(user?.role === 'user' && user.content.some(b => b.type === 'image')).toBe(true)
  })
})
