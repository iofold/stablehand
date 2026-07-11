# Multimodal File Analysis: Research & Design Analysis

> Sources: distilled from the retired survey `multimodal_support_analysis.md` (see git history).

**Status:** Research (pre-implementation)  
**Date:** 2026-04-07  
**Scope:** All 3 harnesses × all 3 model providers  
**Shipping status (2026-07):** Proposal only — not shipped.  

---

## Executive Summary

ctxmill is **entirely text-only today**. The `Message` type, proto schema, harness message builders, and tool handler signatures all use `string` for content. Meanwhile, all three underlying SDKs (LangChain, Claude Agent SDK, PI Agent SDK) already support multimodal content, and the model providers offer increasingly powerful native file analysis — Gemini can analyze 90-minute videos and 1000-page PDFs natively.

Enabling multimodal requires changes at **5 layers**: Message type → Proto schema → Harness message builders → Tool handler signature → A new "analyze file" tool or message pathway.

---

## Part 1: Current State — Everything Is Text

### Message Type (sandbox-daemon)
```typescript
// packages/sandbox-daemon/src/types.ts:50-58
interface Message {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;              // ← TEXT ONLY
  toolCallId?: string;
  toolCalls?: ToolCall[];
  createdAt: Date;
}
```

### API Message Type (shared)
```typescript
// packages/shared/src/api.ts:65-73
interface ApiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;              // ← TEXT ONLY
  toolCallId?: string;
  toolCalls?: ApiToolCallState[];
  parts?: ApiMessagePart[];     // ← exists but NOT used for multimodal
  createdAt: string;
}
```

### Proto Schema
```protobuf
// packages/proto/ctxmill/sandbox/v1/sandbox.proto:173-180
message Message {
  string id = 1;
  string role = 2;
  string content = 3;           // ← STRING ONLY
  repeated ToolCall tool_calls = 4;
  optional string tool_call_id = 5;
  optional string name = 6;
}
```

### Harness Message Construction
All three harnesses build LLM-bound messages using only `content: string`:

- **LangGraph** (line 168): `{ role, content: m.content }` → LangChain message
- **PI Agent** (line 506): `{ role: 'user', content: this.formatTranscriptMessage(m) }` → text prompt
- **Claude** (line 349): `{ role: 'user', content: lastMsg.content }` → SDK message

### Tool Handler Return Type
```typescript
// packages/sandbox-daemon/src/tool/types.ts:10
handler: (input: unknown, ctx: ToolContext) => Promise<string>;  // ← STRING ONLY
```

**Verdict:** Zero multimodal capability exists today. The plumbing is 100% text.

---

## Part 2: What the SDKs Already Support

### LangChain (used by LangGraph harness)

LangChain has a rich multimodal `contentBlocks` API:

```typescript
import { HumanMessage } from "@langchain/core/messages";

new HumanMessage({
  contentBlocks: [
    { type: "text", text: "Analyze this image." },
    { type: "image", data: base64String, mimeType: "image/png" },
  ],
});

new HumanMessage({
  contentBlocks: [
    { type: "text", text: "Summarize this document." },
    { type: "file", data: pdfBase64, mimeType: "application/pdf" },
  ],
});

new HumanMessage({
  contentBlocks: [
    { type: "text", text: "Analyze this video." },
    { type: "video", data: videoBase64, mimeType: "video/mp4" },
  ],
});
```

LangChain providers auto-convert to native API formats:
- **Anthropic**: `{ type: "image", source: { type: "base64", data, media_type } }`
- **OpenAI**: `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`
- **Gemini**: `{ inlineData: { mimeType, data } }` or `{ fileData: { fileUri, mimeType } }`

### PI Agent SDK

PI Agent supports multimodal via `steer()`:

```typescript
await session.steer("Analyze this screenshot", [
  { type: "image", mimeType: "image/png", data: base64String },
]);
```

Currently limited to images. No PDF/video support at SDK level.

### Claude Agent SDK

The SDK accepts Anthropic's native content types:
- `{ type: "image", source: { type: "base64", media_type, data } }`
- `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`

---

## Part 3: Model Provider Capabilities

### Capability Matrix

| Capability | Gemini 2.5 Pro | Claude Opus 4.6 | GPT-5.4 |
|-----------|---------------|-----------------|---------|
| **Images** | ✅ PNG, JPEG, WebP, HEIC | ✅ PNG, JPEG, GIF, WebP | ✅ PNG, JPEG, GIF, WebP |
| **PDFs** | ✅ Native (1000 pages) | ✅ Native `document` type (600 pages) | ❌ Not supported |
| **Video** | ✅ Native (90 min, MP4/WebM/MOV) | ❌ Not supported | ❌ Not supported |
| **Audio** | ✅ MP3, WAV, FLAC, AAC | ❌ Not supported | ✅ MP3, WAV |
| **Max inline size** | 100 MB | 32 MB (whole request) | 20 MB |
| **Max upload size** | 2 GB (File API) | 32 MB (Files API) | 20 MB |
| **File API** | ✅ 48-hour retention | ✅ Files API (beta) | ❌ None |
| **Layout understanding** | ✅ Full PDF layout | ✅ Dual text+image | ❌ N/A |

### Gemini-Unique Capabilities

1. **Video analysis** — only Gemini. Supports temporal understanding, scene segmentation, action extraction with timestamps. Up to 90 minutes, 2 GB.
2. **Large file handling** — File API with async processing, polling for completion, 48-hour cache.
3. **GCS registration** — reference files already in Google Cloud Storage without re-upload.
4. **Signed URL support** — pass S3/Azure signed URLs directly.

### Claude-Unique Capabilities

1. **PDF-first design** — dedicated `document` content type (not just vision/OCR).
2. **Citation support** — precise page-level citations from PDFs.
3. **Better token efficiency** — fewer tokens per PDF page than Gemini.

### OpenAI Limitations

1. **Image only** — no PDF, no video, no audio analysis.
2. **No File API** — everything must be inline (base64 or URL).
3. **Workaround**: convert PDFs to images page-by-page (lossy, expensive).

---

## Part 4: Design Options

### Option A: Content Blocks in Messages (Full Stack Change)

Extend the `Message` type to support content blocks throughout the entire pipeline.

**Changes required:**
1. `Message.content` → `content: string | ContentBlock[]`
2. Proto schema: add `ContentBlock` message type with oneof (text/image/file/video/audio)
3. All 3 harness message builders: construct LangChain `contentBlocks` / Claude content arrays / PI `steer()` images
4. Database schema: store content blocks (JSON or normalized)
5. API types: extend `ApiMessage` for multimodal
6. UI: render image/file content in chat

**Pros:** Full fidelity. Multimodal content persists in conversation history. User can send images via UI.  
**Cons:** Large surface area. Touches every layer. Database migration. UI changes.  
**Effort:** XL (1-2 weeks)

### Option B: Multimodal Tool (Harness-Internal, No Stack Change)

Add an intrinsic tool that reads files from the workspace and injects multimodal content into the CURRENT LLM call without changing the Message type or proto schema.

```typescript
// Tool: analyze_file
// The tool reads the file, base64-encodes it, and returns a special
// marker that the harness intercepts to inject multimodal content
// into the NEXT model call.

defineTool({
  name: 'analyze_file',
  description: 'Analyze an image, PDF, or video file using the model\'s native vision capabilities',
  input: z.object({
    path: z.string().describe('Workspace-relative file path'),
    prompt: z.string().describe('What to analyze or look for'),
  }),
  handler: async ({ path, prompt }, ctx) => {
    // Read file from workspace
    const fullPath = resolve(ctx.workspaceDir, path);
    const buffer = await readFile(fullPath);
    const base64 = buffer.toString('base64');
    const mimeType = detectMimeType(path);

    // Return as structured result that harness can intercept
    return JSON.stringify({
      __multimodal: true,
      content: [
        { type: detectContentType(mimeType), data: base64, mimeType },
        { type: 'text', text: prompt },
      ],
    });
  },
});
```

Each harness then checks for `__multimodal` in tool results and constructs the appropriate SDK-specific multimodal message.

**Pros:** No proto/DB/API changes. Harness-internal only. Can ship incrementally per harness.  
**Cons:** Multimodal content doesn't persist in history. Tool return is a hack. Large files bloat tool results.  
**Effort:** Medium (2-3 days per harness)

### Option C: Hybrid — Multimodal Tool + File References (Recommended)

Combine a multimodal tool with file references that avoid base64 bloat.

```
Agent calls analyze_file(path, prompt)
  → Tool reads file metadata (size, mime type)
  → For small files (<20MB): base64 encode, pass inline
  → For large files (>20MB): upload to provider File API (Gemini) or S3
  → Return file reference: { ref: "file://workspace/report.pdf", mimeType, uploaded?: providerUri }
  → Harness intercepts reference in next model call
  → Harness constructs multimodal message using reference
  → Model analyzes file natively
  → Text result flows back through normal AgentEvent stream
```

**Key insight:** The multimodal content only needs to exist for the duration of the LLM call. It doesn't need to persist in the conversation history as binary. The conversation history stores: "I analyzed report.pdf and found: [text summary]".

```typescript
// What gets stored in Message history (text-only, no change needed):
{
  role: 'tool',
  content: 'The PDF contains a quarterly earnings report showing...',
  toolCallId: 'tc_123',
}

// What actually went to the LLM (multimodal, harness-internal):
new HumanMessage({
  contentBlocks: [
    { type: 'file', data: pdfBase64, mimeType: 'application/pdf' },
    { type: 'text', text: 'Analyze this PDF.' },
  ],
})
```

**Pros:**  
- No proto/DB/API/UI changes needed
- Large file support via provider File APIs
- Clean separation: multimodal is a tool capability, not a message format concern
- Incremental: ship one harness at a time
- Works with existing artifact storage (S3/MinIO) for large files

**Cons:**  
- Multimodal content not replayable from history (but summary text is)
- Requires per-harness implementation of the multimodal injection
- Users can't send images via the chat UI (future enhancement)

**Effort:** Large (3-5 days total across all harnesses)

---

## Part 5: Recommended Architecture (Option C Detail)

### New Tool: `analyze_file`

Location: `packages/sandbox-daemon/src/tool/` (daemon-location tool, like artifact tools)

```typescript
interface AnalyzeFileInput {
  path: string;           // workspace-relative file path
  prompt?: string;        // optional analysis prompt (appended to user message)
}

// Tool definition
{
  name: 'analyze_file',
  description: 'Analyze an image, PDF, video, or audio file using the model\'s native multimodal capabilities. '
    + 'Supported: images (PNG, JPEG, WebP), PDFs, video (MP4, WebM — Gemini only), audio (MP3, WAV).',
  input: z.object({
    path: z.string().describe('Path to file in the workspace'),
    prompt: z.string().optional().describe('What to analyze or look for in the file'),
  }),
  location: 'daemon',
  requiresApproval: false,
}
```

### Harness Integration: Multimodal Message Injection

Each harness needs a mechanism to inject multimodal content into the next LLM call. This does NOT change `deliverTurn()` or the event stream — it changes how the harness constructs the model-bound message.

#### LangGraph Harness

```typescript
// In deliverTurn(), when building langchainMessages:
// If a tool result contains __multimodal marker, construct contentBlocks

const langchainMessages = this.transcript.map((m) => {
  // Check if this is a multimodal tool result
  if (m.role === 'tool' && isMultimodalResult(m.content)) {
    const parsed = JSON.parse(m.content);
    return new HumanMessage({
      contentBlocks: parsed.contentBlocks.map(toContentBlock),
    });
  }
  // Normal text message
  return { role: m.role, content: m.content };
});
```

#### PI Agent Harness

```typescript
// In deliverTurn(), before calling nativeSession.prompt():
// If the last message references a multimodal result, use steer() instead

if (hasMultimodalContent(lastMessage)) {
  const images = extractImages(lastMessage);
  await nativeSession.steer(lastMessage.textContent, images);
} else {
  await nativeSession.prompt(lastMessage.content);
}
```

Note: PI Agent currently supports images only. PDF/video would need to be handled differently (possibly extract text/frames as fallback, or skip if model doesn't support it).

#### Claude Agents Harness

```typescript
// In generateInput(), construct multimodal SDK messages:
if (isMultimodalResult(lastMsg.content)) {
  const parsed = JSON.parse(lastMsg.content);
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: parsed.contentBlocks.map(toClaudeContentBlock),
      // e.g., { type: 'document', source: { type: 'base64', data, media_type } }
    },
  };
}
```

### Large File Handling: Provider File APIs

For files exceeding inline size limits:

| Provider | Threshold | Upload Mechanism | Reference Format |
|----------|-----------|-----------------|-----------------|
| **Gemini** | >100 MB (or any video) | `genai.upload_file()` → poll for ACTIVE | `{ fileData: { fileUri, mimeType } }` |
| **Claude** | >32 MB | Claude Files API (beta) | `{ source: { type: 'file', file_id } }` |
| **OpenAI** | >20 MB | ❌ Not supported | Must reduce file size |

The `analyze_file` tool would detect the current harness's model provider and route accordingly:

```typescript
async function uploadLargeFile(
  filePath: string,
  mimeType: string,
  provider: 'openai' | 'anthropic' | 'google',
  secrets: ResolvedSecrets,
): Promise<FileReference> {
  switch (provider) {
    case 'google': {
      const client = new GoogleGenerativeAI({ apiKey: secrets.GOOGLE_API_KEY });
      const uploaded = await client.files.upload({ file: filePath });
      // Poll for video processing
      if (mimeType.startsWith('video/')) {
        await waitForProcessing(client, uploaded);
      }
      return { type: 'fileUri', uri: uploaded.uri, mimeType };
    }
    case 'anthropic': {
      // Use Claude Files API
      return { type: 'fileId', id: uploadedFile.id, mimeType };
    }
    case 'openai': {
      throw new Error(`File too large for OpenAI (${fileSize} bytes). Max: 20 MB.`);
    }
  }
}
```

### Provider Capability Gating

The tool should be aware of what the current model can handle:

```typescript
const PROVIDER_CAPABILITIES: Record<string, {
  image: boolean;
  pdf: boolean;
  video: boolean;
  audio: boolean;
  maxInlineBytes: number;
}> = {
  openai:    { image: true, pdf: false, video: false, audio: true,  maxInlineBytes: 20_000_000 },
  anthropic: { image: true, pdf: true,  video: false, audio: false, maxInlineBytes: 32_000_000 },
  google:    { image: true, pdf: true,  video: true,  audio: true,  maxInlineBytes: 100_000_000 },
};
```

If an agent on OpenAI tries to analyze a PDF, the tool should:
1. Attempt to extract text (fallback)
2. Or convert pages to images (lossy fallback)
3. Or return an error explaining the model doesn't support PDFs natively

---

## Part 6: Interaction with Workspace Middleware

The multimodal file analysis feature intersects with the workspace middleware system in a natural way:

### Middleware Can Intercept Multimodal Content

Using the `wrapToolCall` hook from the middleware spec:

```typescript
// middleware/image-redaction.ts
export default defineMiddleware({
  name: 'image-redaction',
  wrapToolCall: async (req, ctx, next) => {
    if (req.name === 'analyze_file') {
      // Could: validate file types, enforce size limits, log access
      ctx.logger.info(`File analysis: ${req.args.path}`);
    }
    return next(req);
  },
});
```

### Middleware Can Gate Multimodal by Policy

```typescript
// middleware/no-video-analysis.ts
export default defineMiddleware({
  name: 'no-video-analysis',
  wrapToolCall: async (req, ctx, next) => {
    if (req.name === 'analyze_file') {
      const ext = path.extname(req.args.path).toLowerCase();
      if (['.mp4', '.webm', '.mov', '.avi'].includes(ext)) {
        return {
          result: 'Video analysis is disabled by workspace policy.',
          error: 'blocked_by_policy',
          durationMs: 0,
        };
      }
    }
    return next(req);
  },
});
```

---

## Part 7: Open Questions

1. **Should multimodal content persist in conversation history?** Option C says no — only the text summary persists. This is simpler but means you can't "replay" a multimodal analysis from history. Is this acceptable?

2. **User-initiated multimodal (chat UI)?** Currently out of scope. But the API/UI could be extended later to accept file uploads in user messages. This would require Option A (full stack change) for the upload path, while still using Option C for agent-initiated analysis.

3. **How should the PI agent handle PDFs/video?** PI SDK only supports images. Options: (a) extract text from PDF as fallback, (b) convert PDF pages to images, (c) skip unsupported types with clear error, (d) use a different model provider for PDF analysis.

4. **Gemini File API lifecycle management.** Uploaded files expire after 48 hours. For long-running sessions, files may need re-upload. Who manages this — the tool, the harness, or the middleware?

5. **Cost tracking.** Multimodal inputs can be expensive (1500-3000 tokens per PDF page for Claude, proportional for images). Should the `analyze_file` tool report estimated token cost? This could integrate with the budget-tracker middleware from the middleware spec.

6. **Security.** Files are already inside the sandbox container (workspace isolation). But should there be path validation to prevent analyzing files outside `/workspace`? The existing artifact tools already do this.

---

## Part 8: Implementation Ordering

| Phase | What | Effort | Dependencies |
|-------|------|--------|-------------|
| **1** | `analyze_file` tool (daemon-location, small files only, base64 inline) | 1 day | None |
| **2** | LangGraph harness multimodal injection (images + PDFs via LangChain contentBlocks) | 1 day | Phase 1 |
| **3** | Claude harness multimodal injection (images + PDFs via document type) | 1 day | Phase 1 |
| **4** | PI agent harness multimodal injection (images only via steer()) | 0.5 day | Phase 1 |
| **5** | Large file support (Gemini File API upload + polling) | 1 day | Phase 2 |
| **6** | Video analysis (Gemini only, File API + async processing) | 0.5 day | Phase 5 |
| **7** | Provider capability gating + graceful fallbacks | 0.5 day | Phases 2-4 |
| **8** | Middleware integration (wrapToolCall for analyze_file) | 0.5 day | Middleware spec |
| **Total** | | **~6 days** | |
