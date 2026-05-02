# Web Text Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web text send/receive flow that displays text inline while preserving existing curl and file-transfer behavior.

**Architecture:** Reuse the existing `PUT /{id}` and `GET /{id}` streaming endpoints. The Web client will represent text as a `Blob` with `text/plain; charset=utf-8`, and the receiver will render known text content types inline instead of forcing a download.

**Tech Stack:** Rust, Axum, Tokio, React, TypeScript, Vite.

---

## File Structure

- Modify `src/main.rs`: add a focused server test proving `text/plain` content type and body are forwarded.
- Modify `web/src/App.tsx`: add text/files send mode, text payload builder, inline text receive detection, copy/download actions.
- Modify `web/src/styles.css`: add compact controls and preview styles that fit the current UI.
- Keep `README.md` unchanged.

## Task 1: Server Text Header Coverage

**Files:**
- Modify: `src/main.rs`

- [ ] **Step 1: Add a failing Rust test**

Add this test inside the existing `#[cfg(test)] mod tests` block:

```rust
#[tokio::test]
async fn test_text_plain_content_type_forwarded() {
  let app = test_router();

  let sender_app = app.clone();
  let sender_handle = tokio::spawn(async move {
    let req = Request::builder()
      .method(Method::PUT)
      .uri("/text-forward")
      .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
      .body(Body::from("hello from web text"))
      .unwrap();
    sender_app.oneshot(req).await.unwrap()
  });

  let req = Request::builder()
    .uri("/text-forward")
    .body(Body::empty())
    .unwrap();
  let receiver_resp = app.oneshot(req).await.unwrap();

  assert_eq!(receiver_resp.status(), StatusCode::OK);
  assert_eq!(
    receiver_resp.headers().get(header::CONTENT_TYPE).unwrap(),
    "text/plain; charset=utf-8"
  );

  let body = receiver_resp.into_body().collect().await.unwrap().to_bytes();
  assert_eq!(body.as_ref(), b"hello from web text");

  let sender_resp = sender_handle.await.unwrap();
  assert_eq!(sender_resp.status(), StatusCode::OK);
}
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
cargo test test_text_plain_content_type_forwarded
```

Expected: PASS, because server header forwarding already exists.

- [ ] **Step 3: Commit server test**

```bash
git add src/main.rs
git commit -m "test: cover text content type forwarding"
```

## Task 2: Web Text Send Mode

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add text mode state and upload payload builder**

In `web/src/App.tsx`, add:

```ts
type SendContentMode = "text" | "files";

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const TEXT_FILENAME = "message.txt";

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function buildTextUploadPayload(text: string): UploadPayload {
  return {
    body: new Blob([text], { type: TEXT_CONTENT_TYPE }),
    contentType: TEXT_CONTENT_TYPE,
    archiveName: TEXT_FILENAME,
    totalSize: utf8ByteLength(text),
    fileNames: [TEXT_FILENAME]
  };
}
```

Add state:

```ts
const [sendContentMode, setSendContentMode] = useState<SendContentMode>("text");
const [textValue, setTextValue] = useState("");
```

- [ ] **Step 2: Update send validation and payload selection**

Change `startSend` so it accepts non-empty text in Text mode or files in Files mode:

```ts
const trimmedText = textValue.trim();
if (isSending || (sendContentMode === "files" && files.length === 0) || (sendContentMode === "text" && trimmedText.length === 0)) {
  if (sendContentMode === "text" && trimmedText.length === 0) {
    setSendError("Text is empty");
  }
  return;
}

const uploadPayload =
  sendContentMode === "text"
    ? buildTextUploadPayload(textValue)
    : await buildUploadPayload(files);
```

- [ ] **Step 3: Update Send card UI**

Render a segmented mode switch above the send body:

```tsx
<div className="content-tabs">
  <button type="button" className={sendContentMode === "text" ? "active" : ""} onClick={() => setSendContentMode("text")}>
    Text
  </button>
  <button type="button" className={sendContentMode === "files" ? "active" : ""} onClick={() => setSendContentMode("files")}>
    Files
  </button>
</div>
```

In Text mode, render:

```tsx
<textarea
  className="text-composer"
  value={textValue}
  onChange={(event) => {
    setTextValue(event.target.value);
    setSendError("");
    setSendMessage("");
  }}
  placeholder="Paste or type text"
/>
<p>{formatSize(utf8ByteLength(textValue))}</p>
```

In Files mode, preserve the existing picker/list flow.

- [ ] **Step 4: Add styles**

In `web/src/styles.css`, add styles for `.content-tabs` and `.text-composer` matching existing card controls.

- [ ] **Step 5: Build Web**

Run:

```bash
cd web && npm run build
```

Expected: TypeScript and Vite build pass.

- [ ] **Step 6: Commit Web send mode**

```bash
git add web/src/App.tsx web/src/styles.css
git commit -m "feat: add web text send mode"
```

## Task 3: Web Inline Text Receive

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add text detection and download helper**

Add:

```ts
function isInlineTextContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/javascript" ||
    normalized === "application/x-javascript"
  );
}

function downloadText(text: string, filename: string, contentType: string): void {
  triggerDownload(new Blob([text], { type: contentType }), filename);
}
```

- [ ] **Step 2: Add receive preview state**

Add:

```ts
const [receivedText, setReceivedText] = useState("");
const [receivedTextFilename, setReceivedTextFilename] = useState("");
const [receivedTextContentType, setReceivedTextContentType] = useState(TEXT_CONTENT_TYPE);
```

Clear these before each receive attempt.

- [ ] **Step 3: Branch receive behavior**

In `startReceive`, after a successful response:

```ts
const contentType = response.headers.get("content-type") || "application/octet-stream";
const filename =
  parseDispositionFilename(response.headers.get("content-disposition")) ||
  (isInlineTextContentType(contentType) ? TEXT_FILENAME : `transfer-${key}.bin`);

if (isInlineTextContentType(contentType)) {
  const text = await response.text();
  setReceivedText(text);
  setReceivedTextFilename(filename);
  setReceivedTextContentType(contentType);
  setReceiveMessage(`Received ${filename}`);
  return;
}

const blob = await response.blob();
triggerDownload(blob, filename);
setReceiveMessage(`Downloaded ${filename}`);
```

- [ ] **Step 4: Render preview actions**

Below Receive messages, render when `receivedText` is non-empty:

```tsx
<div className="text-preview">
  <div className="text-preview-actions">
    <span>{receivedTextFilename}</span>
    <button type="button" onClick={() => void copyTextToClipboard(receivedText)}>
      Copy
    </button>
    <button type="button" onClick={() => downloadText(receivedText, receivedTextFilename || TEXT_FILENAME, receivedTextContentType)}>
      Download
    </button>
  </div>
  <pre>{receivedText}</pre>
</div>
```

- [ ] **Step 5: Add preview styles**

Add `.text-preview`, `.text-preview-actions`, and `.text-preview pre` styles that keep long text scrollable and do not overlap mobile controls.

- [ ] **Step 6: Build Web**

Run:

```bash
cd web && npm run build
```

Expected: build passes.

- [ ] **Step 7: Commit inline receive**

```bash
git add web/src/App.tsx web/src/styles.css
git commit -m "feat: preview received text inline"
```

## Task 4: Final Verification

**Files:**
- No planned file changes.

- [ ] **Step 1: Run Rust tests**

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 2: Run Web build**

```bash
cd web && npm run build
```

Expected: build passes.

- [ ] **Step 3: Inspect final diff**

```bash
git status --short
git log --oneline -5
```

Expected: only intended files changed or committed.

## Self-Review

Spec coverage:

- Text send mode: Task 2.
- Inline browser receive: Task 3.
- Preserve curl/file behavior: Tasks 1 and 4.
- Server zero-storage model: no new endpoint or storage added.
- Verification: Task 4.

Placeholder scan: no TBD/TODO/FIXME placeholders are present.

Type consistency: `SendContentMode`, `UploadPayload`, `TEXT_CONTENT_TYPE`, and preview state names are consistent across tasks.
