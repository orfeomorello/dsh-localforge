/**
 * `localforge_read_document` — a model-callable tool that reads local PDFs,
 * scanned documents, images, or whole folders of them.
 *
 * Why a tool: the automatic expansion in the serializers only fires when a
 * PDF/image path appears in the conversation (a dsh file handle or a path
 * the user typed). When the user just says "read the files in that folder",
 * the model reaches for `read_file`/`bash`, gets binary garbage, and starts
 * trying to `pip install` a PDF library. This tool gives it a direct,
 * dependency-free way to read those files.
 *
 * Images: the tool's text output ends with `[LocalForge Vision Attach: "<path>"]`
 * markers. The LocalForge serializers recognise those markers in tool
 * results and attach the corresponding page/image pixels as base64 Vision
 * blocks (without duplicating the extracted text). Non-LocalForge providers
 * simply see the extracted text.
 *
 * Registered with a raw JSON Schema through `ctx.tools.register()`, so the
 * plugin needs no dependency on `@deepseek-ai/dsh-tools`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  classifyDocumentPath,
  expandDocumentOrImagePath,
  type DocumentExpandOptions,
} from './pdf-and-image.ts'

export const READ_DOCUMENT_TOOL_NAME = 'localforge_read_document'

/** Maximum files expanded from a single directory call. */
const MAX_DIRECTORY_FILES = 20

/** Build the Vision attach marker recognised by the serializers. */
export function visionAttachMarker(filePath: string): string {
  return `[LocalForge Vision Attach: ${JSON.stringify(filePath)}]`
}

/**
 * Read one file or every supported file in a directory and return the
 * model-facing text (extracted content + Vision attach markers).
 */
export async function readDocumentForTool(
  targetPath: string,
  options?: DocumentExpandOptions,
): Promise<string> {
  const trimmed = targetPath.trim()
  if (trimmed.length === 0) throw new Error('path must be a non-empty string')
  const resolved = path.resolve(trimmed)

  let stat
  try {
    stat = await fs.stat(resolved)
  } catch {
    throw new Error(`path not found: "${resolved}"`)
  }

  const files: string[] = []
  let skipped = 0
  if (stat.isDirectory()) {
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const supported = entries
      .filter(e => e.isFile() && classifyDocumentPath(e.name) !== undefined)
      .map(e => path.join(resolved, e.name))
      .sort()
    files.push(...supported.slice(0, MAX_DIRECTORY_FILES))
    skipped = Math.max(0, supported.length - MAX_DIRECTORY_FILES)
    if (files.length === 0) {
      return `No supported files (.pdf, .png, .jpg, .jpeg, .webp, .gif) found in "${resolved}".`
    }
  } else if (stat.isFile()) {
    if (classifyDocumentPath(resolved) === undefined) {
      throw new Error(`unsupported file type: "${resolved}". Supported: .pdf, .png, .jpg, .jpeg, .webp, .gif. Use your regular file tools for text files.`)
    }
    files.push(resolved)
  } else {
    throw new Error(`not a file or directory: "${resolved}"`)
  }

  const sections: string[] = []
  for (const file of files) {
    const res = await expandDocumentOrImagePath(file, { ...options, enabled: true })
    if (res === undefined) {
      sections.push(`[Could not read "${path.basename(file)}" (too large, unreadable, or corrupt)]`)
      continue
    }
    const marker = res.images.length > 0 ? `\n${visionAttachMarker(file)}` : ''
    sections.push(`${res.textSummary}${marker}`)
  }
  if (skipped > 0) {
    sections.push(`(${skipped} more supported file(s) not read; call the tool on individual files to read them.)`)
  }
  return sections.join('\n\n')
}

/** Minimal structural view of the `ctx.tools` registry we rely on. */
export interface ToolsRegistryLike {
  register(definition: unknown): unknown
}

/**
 * Build the raw tool definition for `ctx.tools.register()`.
 *
 * @param getOptions - read the current `documents` config per call (hot reload).
 */
export function buildReadDocumentTool(getOptions: () => DocumentExpandOptions | undefined): unknown {
  return {
    name: READ_DOCUMENT_TOOL_NAME,
    description:
      'Read local PDF documents (including scanned/OCR PDFs) and images (.png, .jpg, .jpeg, .webp, .gif). ' +
      'Pass a file path or a folder path; for a folder, every supported file in it is read (up to 20). ' +
      'Returns the extracted text of each PDF page, and attaches page/image pixels so a vision model can see them. ' +
      'ALWAYS use this tool for PDFs and images instead of read_file, bash, or installing Python packages.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to a PDF/image file, or to a folder containing them.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { path: string }, _exec: unknown): Promise<string> {
      return readDocumentForTool(args.path, getOptions())
    },
  }
}
