# Text Transfer Design

Date: 2026-05-02

## Goal

Add a web flow for sending simple non-binary text content and viewing it directly in the browser, similar to the text-sharing experience of PrivateBin or cryptgeon, while preserving Shuttle Piping's current streaming transfer model.

The existing command-line contract must not change:

```bash
echo "Hello, Piping!" | curl -T - https://host/my-transfer
curl https://host/my-transfer
curl -T ./myfile.txt https://host/file-transfer
curl https://host/file-transfer > received.txt
```

## Chosen Model

Use the existing unencrypted internal transfer model.

The web client will send text as `text/plain; charset=utf-8` over the same `PUT /{id}` endpoint used for files. The receiver will call the same `GET /{id}` endpoint, inspect the response content type, and render known text content types inline instead of forcing a download.

This keeps the service aligned with its current zero-storage streaming design. Client-side encryption and URL-fragment keys are intentionally out of scope for this iteration because they would create a second protocol that is less natural for the existing curl workflow.

## Current System

The server pairs a sender and receiver by transfer ID:

- `PUT /{id}` accepts a streaming body and records the sender's `Content-Type` and `Content-Disposition`.
- `GET /{id}` waits for or consumes the matching sender stream.
- The response streams bytes directly from sender to receiver and forwards content headers.
- Web sessions create a six-digit key, QR link, and metadata, then still transfer through `PUT /{key}` and `GET /{key}`.

The current web UI only builds upload payloads from selected files. Receiving always converts the response to a `Blob` and triggers a browser download, even when the body is plain text.

## User Experience

### Send

The Send card gains a compact mode switch with two choices:

- `Text`: default for writing or pasting simple content.
- `Files`: current file upload flow.

In Text mode:

- Show a large text area.
- Enable Send only when the text is non-empty after trimming.
- Keep the existing `Direct` and `Link` session choices.
- Create session metadata with:
  - `file_names: ["message.txt"]`
  - `archive_name: "message.txt"`
  - `mime_type: "text/plain; charset=utf-8"`
  - `total_size`: UTF-8 byte length
- Send the text body to `PUT /{key}` with:
  - `Content-Type: text/plain; charset=utf-8`
  - `Content-Disposition: inline; filename="message.txt"`

In Files mode:

- Preserve the current file picker, multi-file tar packaging, send button, key display, QR code, and link behavior.

### Receive

The Receive card keeps the six-digit key input.

After `GET /{key}`:

- If the response is a known text content type, read it with `response.text()` and render it inline in a read-only preview area.
- Provide `Copy` and `Download` actions for inline text.
- If the response is not recognized as text, keep the current `Blob` download behavior.

Known text content types:

- Any `text/*`
- `application/json`
- `application/xml`
- `application/javascript`
- `application/x-javascript`

## Components

### Server

No new transfer endpoint is required.

Server-side work should be limited to tests unless implementation reveals a header handling gap. The existing body stream, content type forwarding, and content disposition forwarding are the right primitives for text transfer.

### Web Client

Add small, focused client helpers:

- `SendContentMode = "text" | "files"`
- `isInlineTextContentType(contentType: string | null): boolean`
- `buildTextUploadPayload(text: string): UploadPayload`
- `downloadText(text: string, filename: string, contentType: string)`

The existing `UploadPayload` shape can be reused because text can be represented as a `Blob`.

## Error Handling

- Empty text sends should be blocked client-side with a clear error message.
- Failed session creation or failed upload keeps the existing send error path.
- Failed receive keeps the existing receive error path.
- If text decoding fails unexpectedly, fall back to download rather than losing the transfer.
- Very large text is still transferred through the same streaming endpoint, but the browser preview reads it into memory. This is acceptable for simple non-binary content; large files remain better suited to Files mode.

## Compatibility

This change must preserve:

- `PUT /{id}` and `GET /{id}` semantics.
- Existing curl examples in `README.md`.
- Existing file upload and download behavior.
- QR/link receive flow.
- Server zero-storage streaming behavior.

## Verification

Run:

```bash
cargo test
cd web && npm run build
```

Add or preserve tests for:

- Raw sender/receiver body transfer.
- Content type forwarding for `text/plain`.
- Web TypeScript build.

Manual smoke path:

1. Open `/app`.
2. Send text in Text mode.
3. Receive with the six-digit key in another browser/device.
4. Confirm the text is displayed inline and can be copied or downloaded.
5. Send a file in Files mode.
6. Confirm the receiver still downloads the file.
7. Confirm curl send/receive still works.
