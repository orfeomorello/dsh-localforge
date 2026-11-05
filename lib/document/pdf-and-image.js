/**
 * Automatic document (PDF) and local image expansion for LocalForge.
 *
 * Why this exists:
 *  1. DeepSeek Harness (`dsh-llm`) converts every attached `FileBlock` into
 *     a `TextBlock` before calling `adapter.stream()`, emitting:
 *       `[File "name.pdf" (N bytes, sha256:...): verbatim read-only copy saved at "/path/to/name.pdf". ...]`
 *  2. LM Studio's GUI parses PDFs client-side, but its HTTP server endpoints
 *     (`/v1/chat/completions` and `/v1/messages`) only accept text and
 *     base64-encoded images (`image_url` / `image`).
 *  3. When a user attaches a PDF or image in `dsh`, or references a local
 *     `.pdf` / `.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` file in a folder,
 *     the model on LM Studio would otherwise try to install Python packages
 *     via bash to read the PDF or inspect the image.
 *
 * This module transparently intercepts `dsh` file handles and local document/image
 * paths in user messages and tool results, extracts text and embedded/rendered
 * page images from PDFs, reads local image files into base64 Vision blocks,
 * and provides a `localforge_read_document` tool handler so the model can also
 * inspect any PDF, image, or folder on demand.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024; // 32 MiB
const DEFAULT_MAX_PDF_IMAGES = 8;
const DEFAULT_MAX_PDF_TEXT_CHARS = 100_000;
const IMAGE_EXTENSIONS = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};
/**
 * Regex matching `dsh-llm`'s `fileHandleText()` output:
 * `[File "name.pdf" (123 bytes, sha256:abcdef12): verbatim read-only copy saved at "/path/to/file.pdf". ...]`
 */
const DSH_FILE_HANDLE_RE = /\[File\s+"([^"]+)"\s+\([^)]*\):\s+verbatim read-only copy saved at\s+"([^"]+)"[^\]]*\]/g;
/**
 * Regex matching explicit local file paths ending in `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`
 * inside user prompts (quoted or unquoted Windows/POSIX absolute paths).
 */
const EXPLICIT_LOCAL_PATH_RE = /(?:["']([A-Za-z]:[\\/][^"'\r\n]+?\.(?:pdf|png|jpe?g|webp|gif)|\/[^"'\r\n]+?\.(?:pdf|png|jpe?g|webp|gif))["']|(\b[A-Za-z]:[\\/][^\s"'\r\n<>|?*]+?\.(?:pdf|png|jpe?g|webp|gif)|\B\/(?:[^\s"'\r\n<>|?*/]+\/)+[^\s"'\r\n<>|?*/]+?\.(?:pdf|png|jpe?g|webp|gif)))/gi;
/**
 * Determine if a file path has a supported image or PDF extension.
 */
export function classifyDocumentPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf')
        return { kind: 'pdf' };
    const mediaType = IMAGE_EXTENSIONS[ext];
    if (mediaType !== undefined)
        return { kind: 'image', mediaType };
    return undefined;
}
/**
 * Detect image media type from magic bytes, falling back to extension.
 */
export function detectImageMediaType(buf, fallback = 'image/png') {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return 'image/png';
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return 'image/jpeg';
    }
    if (buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        return 'image/webp';
    }
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return 'image/gif';
    }
    return fallback;
}
// ---------------------------------------------------------------------------
// Pure-JS PDF Text & Embedded Image Extractor (zero native dependencies)
// ---------------------------------------------------------------------------
/** Decode a PDF literal string `(...)`, handling standard escapes and octal codes. */
function decodePdfLiteralString(raw) {
    let out = '';
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
        if (ch !== '\\') {
            out += ch;
            i++;
            continue;
        }
        i++;
        if (i >= raw.length)
            break;
        const esc = raw[i];
        switch (esc) {
            case 'n':
                out += '\n';
                i++;
                break;
            case 'r':
                out += '\r';
                i++;
                break;
            case 't':
                out += '\t';
                i++;
                break;
            case 'b':
                out += '\b';
                i++;
                break;
            case 'f':
                out += '\f';
                i++;
                break;
            case '(':
                out += '(';
                i++;
                break;
            case ')':
                out += ')';
                i++;
                break;
            case '\\':
                out += '\\';
                i++;
                break;
            case '\r':
                i++;
                if (raw[i] === '\n')
                    i++;
                break;
            case '\n':
                i++;
                break;
            default: {
                if (esc >= '0' && esc <= '7') {
                    let oct = esc;
                    i++;
                    if (i < raw.length && raw[i] >= '0' && raw[i] <= '7') {
                        oct += raw[i];
                        i++;
                        if (i < raw.length && raw[i] >= '0' && raw[i] <= '7') {
                            oct += raw[i];
                            i++;
                        }
                    }
                    out += String.fromCharCode(parseInt(oct, 8));
                }
                else {
                    out += esc;
                    i++;
                }
            }
        }
    }
    return out;
}
/** Decode a PDF hex string `<...>`, supporting UTF-16BE BOM (`FEFF`) and Latin-1/UTF-8. */
function decodePdfHexString(hexRaw) {
    const clean = hexRaw.replace(/\s+/g, '');
    if (clean.length === 0)
        return '';
    const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
    const bytes = Buffer.from(padded, 'hex');
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        // UTF-16BE
        let out = '';
        for (let i = 2; i + 1 < bytes.length; i += 2) {
            out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        }
        return out;
    }
    return bytes.toString('latin1');
}
/** Extract text operators (`Tj`, `TJ`, `'`, `"`) from a decompressed PDF content stream. */
function extractTextFromPdfContentStream(content) {
    const chunks = [];
    // Match BT ... ET blocks, or scan entire content if BT/ET are split across streams
    const btEtBlocks = [];
    const btRegex = /\bBT\b([\s\S]*?)\bET\b/g;
    let match;
    while ((match = btRegex.exec(content)) !== null) {
        if (match[1] !== undefined)
            btEtBlocks.push(match[1]);
    }
    const targets = btEtBlocks.length > 0 ? btEtBlocks : [content];
    for (const block of targets) {
        const blockParts = [];
        // Tokenize parenthesized strings, hex strings,TJ arrays, and line-positioning operators
        const tokenRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\[(?:[\s\S]*?)\]\s*TJ|\b(?:Td|TD|T\*|ET)\b/g;
        let tok;
        while ((tok = tokenRe.exec(block)) !== null) {
            const s = tok[0];
            if (s === 'T*' || s === 'ET') {
                blockParts.push('\n');
            }
            else if (s === 'Td' || s === 'TD') {
                // Vertical movement often indicates a new line or word break
                blockParts.push(' ');
            }
            else if (s.startsWith('(') && s.endsWith(')')) {
                blockParts.push(decodePdfLiteralString(s.slice(1, -1)));
            }
            else if (s.startsWith('<') && s.endsWith('>')) {
                blockParts.push(decodePdfHexString(s.slice(1, -1)));
            }
            else if (s.startsWith('[')) {
                // TJ array: extract inner (...) and <...> and large negative kerning numbers
                const innerRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|(-?\d+(?:\.\d+)?)/g;
                let inner;
                while ((inner = innerRe.exec(s)) !== null) {
                    const item = inner[0];
                    if (item.startsWith('(') && item.endsWith(')')) {
                        blockParts.push(decodePdfLiteralString(item.slice(1, -1)));
                    }
                    else if (item.startsWith('<') && item.endsWith('>')) {
                        blockParts.push(decodePdfHexString(item.slice(1, -1)));
                    }
                    else if (inner[1] !== undefined) {
                        const kern = parseFloat(inner[1]);
                        if (kern < -180)
                            blockParts.push(' ');
                    }
                }
            }
        }
        const joined = blockParts.join('').replace(/[ \t]+/g, ' ').trim();
        if (joined.length > 0)
            chunks.push(joined);
    }
    return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * Pure-JS fallback parser for PDF buffers:
 *  - Decompresses `/FlateDecode` streams with `node:zlib`
 *  - Extracts text from `BT ... ET` content streams
 *  - Extracts embedded `/DCTDecode` (JPEG) image streams for scanned/OCR PDFs
 */
export function extractPdfPureJs(pdfBuffer, maxImages = DEFAULT_MAX_PDF_IMAGES) {
    const raw = pdfBuffer.toString('latin1');
    // Estimate page count from `/Type /Page` (excluding `/Type /Pages`)
    const pageMatches = raw.match(/\/Type\s*\/Page\b(?!s)/g);
    const pageCount = Math.max(pageMatches?.length ?? 1, 1);
    const textParts = [];
    const images = [];
    // Scan all `stream ... endstream` blocks
    let cursor = 0;
    while (cursor < raw.length) {
        const streamIdx = raw.indexOf('stream', cursor);
        if (streamIdx === -1)
            break;
        // Ensure `stream` is preceded by `>>` within a reasonable distance (the stream dictionary)
        const dictStart = Math.max(0, streamIdx - 1024);
        const headerSlice = raw.slice(dictStart, streamIdx);
        const dictCloseIdx = headerSlice.lastIndexOf('>>');
        if (dictCloseIdx === -1) {
            cursor = streamIdx + 6;
            continue;
        }
        const dictOpenIdx = headerSlice.lastIndexOf('<<', dictCloseIdx);
        const dictText = dictOpenIdx !== -1 ? headerSlice.slice(dictOpenIdx, dictCloseIdx + 2) : headerSlice;
        // Advance past `stream\r\n` or `stream\n`
        let dataStart = streamIdx + 6;
        if (raw[dataStart] === '\r' && raw[dataStart + 1] === '\n')
            dataStart += 2;
        else if (raw[dataStart] === '\n' || raw[dataStart] === '\r')
            dataStart += 1;
        else {
            // Not a real stream keyword (e.g. `endstream` or inside a word)
            cursor = streamIdx + 6;
            continue;
        }
        const endStreamIdx = raw.indexOf('endstream', dataStart);
        if (endStreamIdx === -1)
            break;
        let dataEnd = endStreamIdx;
        if (raw[dataEnd - 2] === '\r' && raw[dataEnd - 1] === '\n')
            dataEnd -= 2;
        else if (raw[dataEnd - 1] === '\n' || raw[dataEnd - 1] === '\r')
            dataEnd -= 1;
        const streamBytes = pdfBuffer.subarray(dataStart, dataEnd);
        cursor = endStreamIdx + 9;
        const isImage = /\/Subtype\s*\/Image\b/.test(dictText);
        const isDCT = /\/DCTDecode\b/.test(dictText);
        const isFlate = /\/FlateDecode\b/.test(dictText);
        // 1. Embedded JPEG image stream (common in scanned PDFs / OCR documents)
        if (isImage && isDCT && images.length < maxImages) {
            if (streamBytes.length >= 3 && streamBytes[0] === 0xff && streamBytes[1] === 0xd8) {
                images.push({
                    mediaType: 'image/jpeg',
                    base64: Buffer.from(streamBytes).toString('base64'),
                    label: `embedded-image-${images.length + 1}.jpg`,
                });
            }
            continue;
        }
        if (isImage)
            continue;
        // 2. Content stream (compressed or uncompressed)
        let decodedContent;
        if (isFlate) {
            try {
                decodedContent = zlib.inflateSync(streamBytes).toString('latin1');
            }
            catch {
                try {
                    decodedContent = zlib.inflateRawSync(streamBytes).toString('latin1');
                }
                catch {
                    // Ignore undecodable stream
                }
            }
        }
        else if (!/\/Filter\b/.test(dictText)) {
            decodedContent = streamBytes.toString('latin1');
        }
        if (decodedContent !== undefined && (decodedContent.includes('BT') || decodedContent.includes('Tj') || decodedContent.includes('TJ'))) {
            const extracted = extractTextFromPdfContentStream(decodedContent);
            if (extracted.length > 0)
                textParts.push(extracted);
        }
    }
    return {
        pageCount,
        text: textParts.join('\n\n').trim(),
        images,
    };
}
// ---------------------------------------------------------------------------
// Python `pypdf` + `Pillow` helper (when available on the host)
// ---------------------------------------------------------------------------
const PYTHON_PDF_HELPER_SCRIPT = `
import sys, json, base64, io

pdf_path = sys.argv[1]
max_images = int(sys.argv[2])

import pypdf
reader = pypdf.PdfReader(pdf_path)
pages_text = []
images = []

for idx, page in enumerate(reader.pages):
    try:
        t = (page.extract_text() or "").strip()
    except Exception:
        t = ""
    if t:
        pages_text.append(f"--- Page {idx + 1} ---\\n{t}")
    if len(images) < max_images:
        try:
            for img in page.images:
                if len(images) >= max_images:
                    break
                data = img.data
                name = (getattr(img, "name", "") or f"page-{idx+1}.png").lower()
                if data[:3] == b"\\xff\\xd8\\xff":
                    mime = "image/jpeg"
                elif data[:8] == b"\\x89PNG\\r\\n\\x1a\\n":
                    mime = "image/png"
                elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                    mime = "image/webp"
                else:
                    # Convert via Pillow to PNG if possible
                    try:
                        from PIL import Image
                        im = Image.open(io.BytesIO(data))
                        buf = io.BytesIO()
                        im.save(buf, format="PNG")
                        data = buf.getvalue()
                        mime = "image/png"
                    except Exception:
                        continue
                images.append({
                    "mediaType": mime,
                    "base64": base64.b64encode(data).decode("ascii"),
                    "label": f"page-{idx + 1}-{name}",
                })
        except Exception:
            pass

print(json.dumps({
    "pageCount": len(reader.pages),
    "text": "\\n\\n".join(pages_text),
    "images": images,
}))
`.trim();
async function tryExtractPdfWithPython(filePath, maxImages) {
    for (const cmd of ['python', 'python3']) {
        try {
            const { stdout } = await execFileAsync(cmd, ['-c', PYTHON_PDF_HELPER_SCRIPT, filePath, String(maxImages)], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
            const parsed = JSON.parse(stdout.trim());
            if (typeof parsed.pageCount === 'number') {
                return {
                    pageCount: parsed.pageCount,
                    text: parsed.text ?? '',
                    images: Array.isArray(parsed.images) ? parsed.images : [],
                };
            }
        }
        catch {
            // Python or pypdf not installed / failed — fall through to pure-JS
        }
    }
    return undefined;
}
/**
 * Extract text and embedded/scanned images from a PDF file on disk.
 * Uses `pypdf` + `Pillow` when available for full CMap/font & image support,
 * and falls back to the built-in pure-JS PDF stream parser so `dsh-localforge`
 * works out-of-the-box with zero external dependencies.
 */
export async function extractPdfFile(filePath, options) {
    const maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxPdfImages = options?.maxPdfImages ?? DEFAULT_MAX_PDF_IMAGES;
    const maxPdfTextChars = options?.maxPdfTextChars ?? DEFAULT_MAX_PDF_TEXT_CHARS;
    const includeVisionImages = options?.includeVisionImages ?? true;
    const stat = await fs.stat(filePath);
    if (stat.size > maxFileBytes) {
        throw new Error(`PDF file "${path.basename(filePath)}" (${stat.size} bytes) exceeds limit (${maxFileBytes} bytes)`);
    }
    const fileName = path.basename(filePath);
    const pdfBuffer = await fs.readFile(filePath);
    // 1. Try Pure-JS first for speed on simple PDFs, and Python pypdf when available
    //    for full CMap/font decoding and Flate/JPX image conversion.
    const pureResult = extractPdfPureJs(pdfBuffer, maxPdfImages);
    const pyResult = await tryExtractPdfWithPython(filePath, maxPdfImages);
    const pageCount = pyResult?.pageCount ?? pureResult.pageCount;
    const rawText = (pyResult !== undefined && pyResult.text.length >= pureResult.text.length)
        ? pyResult.text
        : pureResult.text;
    const rawImages = (pyResult !== undefined && pyResult.images.length >= pureResult.images.length)
        ? pyResult.images
        : pureResult.images;
    const truncatedText = rawText.length > maxPdfTextChars
        ? `${rawText.slice(0, maxPdfTextChars)}\n...[truncated at ${maxPdfTextChars} chars]`
        : rawText;
    const images = includeVisionImages ? rawImages.slice(0, maxPdfImages) : [];
    const summaryParts = [
        `[LocalForge PDF Extracted: "${fileName}" (${pageCount} page${pageCount === 1 ? '' : 's'})]`,
    ];
    if (truncatedText.length > 0) {
        summaryParts.push(truncatedText);
    }
    else if (images.length > 0) {
        summaryParts.push(`(No selectable text layer found in "${fileName}"; ${images.length} scanned page/embedded image(s) attached directly for Vision OCR analysis.)`);
    }
    else {
        summaryParts.push(`(No selectable text or embedded images found in "${fileName}".)`);
    }
    return {
        filePath,
        fileName,
        kind: 'pdf',
        textSummary: summaryParts.join('\n'),
        images,
    };
}
/**
 * Load a local image file (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) from disk
 * into a Vision base64 payload.
 */
export async function extractImageFile(filePath, fallbackMediaType, options) {
    const maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const includeVisionImages = options?.includeVisionImages ?? true;
    const stat = await fs.stat(filePath);
    if (stat.size > maxFileBytes) {
        throw new Error(`Image file "${path.basename(filePath)}" (${stat.size} bytes) exceeds limit (${maxFileBytes} bytes)`);
    }
    const fileName = path.basename(filePath);
    const bytes = await fs.readFile(filePath);
    const mediaType = detectImageMediaType(bytes, fallbackMediaType);
    return {
        filePath,
        fileName,
        kind: 'image',
        textSummary: `[LocalForge Vision Image Attached: "${fileName}" (${mediaType}, ${stat.size} bytes)]`,
        images: includeVisionImages
            ? [{
                    mediaType,
                    base64: bytes.toString('base64'),
                    label: fileName,
                }]
            : [],
    };
}
/**
 * Expand a single file path if it exists and is a supported PDF or image.
 */
export async function expandDocumentOrImagePath(filePath, options) {
    if (options?.enabled === false)
        return undefined;
    const classification = classifyDocumentPath(filePath);
    if (classification === undefined)
        return undefined;
    if (!existsSync(filePath))
        return undefined;
    try {
        if (classification.kind === 'pdf') {
            return await extractPdfFile(filePath, options);
        }
        return await extractImageFile(filePath, classification.mediaType, options);
    }
    catch {
        return undefined;
    }
}
/**
 * Scan a text string for:
 *  1. `dsh` file handles (`[File "name.pdf" (...): verbatim read-only copy saved at "/path/..."]`)
 *  2. Explicit existing local file paths ending in `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`
 *
 * Returns the augmented text (with extracted PDF content / Vision annotations)
 * and any extracted Vision images to attach as `image_url` / `image` parts.
 */
export async function expandTextWithLocalDocuments(text, options) {
    if (options?.enabled === false || text.length === 0) {
        return { text, images: [] };
    }
    const seenPaths = new Set();
    const candidatePaths = [];
    // 1. Match dsh file handles: `[File "..." (...): verbatim read-only copy saved at "<path>"...]`
    for (const match of text.matchAll(DSH_FILE_HANDLE_RE)) {
        const savedPath = match[2];
        if (savedPath !== undefined && !seenPaths.has(savedPath)) {
            seenPaths.add(savedPath);
            candidatePaths.push(savedPath);
        }
    }
    // 2. Match explicit local paths to .pdf or image files in the message text
    for (const match of text.matchAll(EXPLICIT_LOCAL_PATH_RE)) {
        const rawPath = (match[1] ?? match[2])?.trim();
        if (rawPath !== undefined && !seenPaths.has(rawPath)) {
            seenPaths.add(rawPath);
            candidatePaths.push(rawPath);
        }
    }
    // 3. Match explicit local directory paths (e.g. "read the files in C:\my-docs")
    const candidateDirs = [];
    for (const match of text.matchAll(EXPLICIT_DIR_PATH_RE)) {
        const rawDir = (match[1] ?? match[2])?.trim().replace(/[.,;:!?)]+$/, '');
        if (rawDir !== undefined && !seenPaths.has(rawDir) && classifyDocumentPath(rawDir) === undefined) {
            seenPaths.add(rawDir);
            candidateDirs.push(rawDir);
        }
    }
    if (candidatePaths.length === 0 && candidateDirs.length === 0) {
        return { text, images: [] };
    }
    const appendedSummaries = [];
    const extractedImages = [];
    for (const candidatePath of candidatePaths) {
        const expanded = await expandDocumentOrImagePath(candidatePath, options);
        if (expanded !== undefined) {
            appendedSummaries.push(expanded.textSummary);
            extractedImages.push(...expanded.images);
        }
    }
    for (const dirPath of candidateDirs) {
        try {
            if (!existsSync(dirPath))
                continue;
            const stat = await fs.stat(dirPath);
            if (!stat.isDirectory())
                continue;
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const docFiles = entries.filter(e => e.isFile() && classifyDocumentPath(e.name) !== undefined);
            // Expand up to 10 PDF/image files in a referenced folder
            if (docFiles.length > 0 && docFiles.length <= 10) {
                const dirResult = await inspectLocalPathOrDirectory(dirPath, options);
                if (dirResult.text.length > 0) {
                    appendedSummaries.push(dirResult.text);
                    extractedImages.push(...dirResult.images);
                }
            }
        }
        catch {
            // Ignore inaccessible directories
        }
    }
    if (appendedSummaries.length === 0) {
        return { text, images: [] };
    }
    return {
        text: `${text}\n\n${appendedSummaries.join('\n\n')}`,
        images: extractedImages,
    };
}
/**
 * Inspect a local file or directory path for PDFs and images.
 * Used when a user or tool asks to read all documents/images in a folder.
 */
export async function inspectLocalPathOrDirectory(targetPath, options) {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
        const res = await expandDocumentOrImagePath(targetPath, options);
        if (res !== undefined) {
            return { text: res.textSummary, images: res.images };
        }
        const content = await fs.readFile(targetPath, 'utf8');
        return { text: content, images: [] };
    }
    if (stat.isDirectory()) {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const summaries = [];
        const images = [];
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const fullPath = path.join(targetPath, entry.name);
            const res = await expandDocumentOrImagePath(fullPath, options);
            if (res !== undefined) {
                summaries.push(res.textSummary);
                images.push(...res.images);
            }
        }
        if (summaries.length === 0) {
            return {
                text: `No supported PDF or image files (.pdf, .png, .jpg, .jpeg, .webp, .gif) found in "${targetPath}".`,
                images: [],
            };
        }
        return {
            text: `[LocalForge Directory Scan: "${targetPath}" (${summaries.length} document/image file(s) expanded)]\n\n${summaries.join('\n\n')}`,
            images,
        };
    }
    return { text: `Unsupported path: "${targetPath}"`, images: [] };
}
/**
 * Regex matching explicit directory paths in user prompts (Windows `C:\...` or POSIX `/...`)
 * when they don't already have a `.pdf`/image extension.
 */
const EXPLICIT_DIR_PATH_RE = /(?:["']([A-Za-z]:[\\/][^"'\r\n<>|?*]+|\/(?:[^\s"'\r\n<>|?*/]+\/)+[^\s"'\r\n<>|?*/]+)["']|(\b[A-Za-z]:[\\/][^\s"'\r\n<>|?*]+))/g;
