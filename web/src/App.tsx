import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type TransferMode = "direct" | "link";
type SendContentMode = "text" | "files";

type SessionState =
  | "reserved"
  | "sender_waiting"
  | "receiver_waiting"
  | "active"
  | "completed"
  | "expired";

interface SessionMetadata {
  file_names: string[];
  total_size?: number;
  archive_name?: string;
  mime_type?: string;
}

interface SessionResponse {
  key: string;
  mode: TransferMode;
  status: SessionState;
  expires_at: string;
  link_url: string;
  qr_payload: string;
}

interface SessionStatusResponse {
  key: string;
  mode: TransferMode;
  status: SessionState;
  expires_at: string;
  seconds_left: number;
  metadata?: SessionMetadata;
  link_url: string;
}

interface UploadPayload {
  body: Blob | File;
  contentType: string;
  archiveName: string;
  totalSize: number;
  fileNames: string[];
}

const TAR_BLOCK_SIZE = 512;
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const TEXT_FILENAME = "message.txt";
const GITHUB_URL = "https://github.com/thomas7725353/shuttle-piping";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function writeString(buffer: Uint8Array, offset: number, length: number, value: string): void {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  buffer.set(encoded.slice(0, length), offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void {
  const octal = Math.floor(value).toString(8);
  const padded = octal.padStart(length - 1, "0");
  writeString(buffer, offset, length - 1, padded);
  buffer[offset + length - 1] = 0;
}

function buildTarHeader(name: string, size: number, mtime: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const safeName = name.slice(0, 100);

  writeString(header, 0, 100, safeName);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);

  // Checksum placeholder must be spaces.
  for (let i = 148; i < 156; i += 1) {
    header[i] = 0x20;
  }

  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  header[262] = 0;
  writeString(header, 263, 2, "00");

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }

  const checksumText = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function buildTarArchive(files: File[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  for (const file of files) {
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const mtime = Math.floor(file.lastModified / 1000);
    const header = buildTarHeader(file.name, fileBytes.length, mtime);

    chunks.push(header);
    chunks.push(fileBytes);

    const remainder = fileBytes.length % TAR_BLOCK_SIZE;
    if (remainder > 0) {
      chunks.push(new Uint8Array(TAR_BLOCK_SIZE - remainder));
    }
  }

  // Tar footer: two empty blocks.
  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));

  return concatUint8Arrays(chunks);
}

async function gzipTar(bytes: Uint8Array): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") {
    return null;
  }

  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(toArrayBuffer(bytes));
  await writer.close();
  return new Response(stream.readable).blob();
}

function parseDispositionFilename(disposition: string | null): string | null {
  if (!disposition) {
    return null;
  }

  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    return decodeURIComponent(utf8[1]);
  }

  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1] ?? null;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

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

async function buildUploadPayload(files: File[]): Promise<UploadPayload> {
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  if (files.length === 1) {
    const file = files[0];
    return {
      body: file,
      contentType: file.type || "application/octet-stream",
      archiveName: file.name,
      totalSize,
      fileNames: [file.name]
    };
  }

  const tarBytes = await buildTarArchive(files);
  const gzBlob = await gzipTar(tarBytes);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (gzBlob) {
    return {
      body: gzBlob,
      contentType: "application/gzip",
      archiveName: `shuttle-piping-${stamp}.tar.gz`,
      totalSize,
      fileNames: files.map((file) => file.name)
    };
  }

  return {
    body: new Blob([toArrayBuffer(tarBytes)], { type: "application/x-tar" }),
    contentType: "application/x-tar",
    archiveName: `shuttle-piping-${stamp}.tar`,
    totalSize,
    fileNames: files.map((file) => file.name)
  };
}

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

async function createSession(mode: TransferMode, metadata: SessionMetadata): Promise<SessionResponse> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode, metadata })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function fetchSessionStatus(key: string): Promise<SessionStatusResponse> {
  const response = await fetch(`/api/session/${key}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoLinkHandled = useRef(false);

  const [sendContentMode, setSendContentMode] = useState<SendContentMode>("text");
  const [textValue, setTextValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<TransferMode>("direct");
  const [sendError, setSendError] = useState<string>("");
  const [sendMessage, setSendMessage] = useState<string>("");
  const [isSending, setIsSending] = useState(false);

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionState | "">("");
  const [secondsLeft, setSecondsLeft] = useState(0);

  const [receiveKey, setReceiveKey] = useState("");
  const [receiveError, setReceiveError] = useState("");
  const [isReceiving, setIsReceiving] = useState(false);
  const [receiveMessage, setReceiveMessage] = useState("");
  const [receivedText, setReceivedText] = useState("");
  const [receivedTextFilename, setReceivedTextFilename] = useState("");
  const [receivedTextContentType, setReceivedTextContentType] = useState(TEXT_CONTENT_TYPE);
  const [copyMessage, setCopyMessage] = useState("");

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );
  const textSize = useMemo(() => utf8ByteLength(textValue), [textValue]);

  const openPicker = () => fileInputRef.current?.click();

  const resetSend = () => {
    setFiles([]);
    setTextValue("");
    setSession(null);
    setSessionStatus("");
    setSecondsLeft(0);
    setSendError("");
    setSendMessage("");
    setCopyMessage("");
    setIsSending(false);
  };

  const onSelectFiles: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const selected = Array.from(event.target.files ?? []);
    if (selected.length === 0) {
      return;
    }

    setFiles((current) => [...current, ...selected]);
    setSendError("");
    setSendMessage("");

    // Allow selecting the same file again.
    event.target.value = "";
  };

  const startReceive = useCallback(
    async (inputKey?: string) => {
      const key = (inputKey ?? receiveKey).trim();
      if (key.length !== 6 || /\D/.test(key)) {
        setReceiveError("Key must be 6 digits");
        return;
      }

      setReceiveError("");
      setReceiveMessage("");
      setReceivedText("");
      setReceivedTextFilename("");
      setReceivedTextContentType(TEXT_CONTENT_TYPE);
      setIsReceiving(true);

      try {
        const response = await fetch(`/${key}`);
        if (!response.ok) {
          throw new Error(await response.text());
        }

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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Download failed";
        setReceiveError(message);
      } finally {
        setIsReceiving(false);
      }
    },
    [receiveKey]
  );

  const startSend = async () => {
    const trimmedText = textValue.trim();
    if (
      isSending ||
      (sendContentMode === "files" && files.length === 0) ||
      (sendContentMode === "text" && trimmedText.length === 0)
    ) {
      if (sendContentMode === "text" && trimmedText.length === 0) {
        setSendError("Text is empty");
      }
      return;
    }

    setSendError("");
    setSendMessage("");
    setIsSending(true);

    try {
      const uploadPayload =
        sendContentMode === "text"
          ? buildTextUploadPayload(textValue)
          : await buildUploadPayload(files);
      const metadata: SessionMetadata = {
        file_names: uploadPayload.fileNames,
        total_size: uploadPayload.totalSize,
        archive_name: uploadPayload.archiveName,
        mime_type: uploadPayload.contentType
      };

      const createdSession = await createSession(mode, metadata);
      setSession(createdSession);
      setSessionStatus(createdSession.status);
      setCopyMessage("");

      const uploadResponse = await fetch(`/${createdSession.key}`, {
        method: "PUT",
        headers: {
          "Content-Type": uploadPayload.contentType,
          "Content-Disposition": `${sendContentMode === "text" ? "inline" : "attachment"}; filename="${uploadPayload.archiveName.replace(/"/g, "_")}"`
        },
        body: uploadPayload.body
      });

      if (!uploadResponse.ok) {
        throw new Error(await uploadResponse.text());
      }

      const result = (await uploadResponse.text()).trim();
      setSendMessage(result || "Transfer completed");
      setSessionStatus("completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setSendError(message);
    } finally {
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (!session) {
      return;
    }

    const update = () => {
      const expiresMs = new Date(session.expires_at).getTime();
      const left = Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000));
      setSecondsLeft(left);
    };

    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!session?.key) {
      return;
    }

    const poll = async () => {
      try {
        const status = await fetchSessionStatus(session.key);
        setSessionStatus(status.status);
        setSecondsLeft(status.seconds_left);
      } catch {
        // Ignore polling errors and keep current UI state.
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [session?.key]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const maybeKey = params.get("key");
    const maybeMode = params.get("mode");

    if (!maybeKey) {
      return;
    }

    setReceiveKey(maybeKey);

    if (maybeMode === "link" && !autoLinkHandled.current) {
      autoLinkHandled.current = true;
      void startReceive(maybeKey);
    }
  }, [startReceive]);

  const showWaiting = session !== null;
  const currentLink = session?.link_url ?? "";

  const copyLink = async () => {
    if (!currentLink) {
      return;
    }
    try {
      await copyTextToClipboard(currentLink);
      setCopyMessage("Link copied");
    } catch {
      setCopyMessage("Copy failed");
    }
  };

  return (
    <div className="page-bg">
      <div className="page-shell">
        <header className="app-header">
          <div className="brand-block">
            <span className="eyebrow">Accountless transfer tool</span>
            <h1>Shuttle Piping</h1>
            <p>Send text, code snippets, and small files between browser, phone, container, and terminal.</p>
          </div>
          <div className="header-actions">
            <a className="github-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.99c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.38-.01 2.49-.01 2.83 0 .27.18.6.69.49A10.15 10.15 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"
                />
              </svg>
              Star on GitHub
            </a>
            <span className="health-pill">Ready</span>
          </div>
        </header>

        <section className="intro-band" aria-labelledby="intro-title">
          <div>
            <p className="eyebrow">No login, short-lived sessions, curl-friendly API</p>
            <h2 id="intro-title">Move a note, log, config, or small file from one device to another without setting up an account.</h2>
          </div>
          <div className="intro-metrics" aria-label="Tool highlights">
            <span>6-digit key</span>
            <span>QR link</span>
            <span>curl PUT/GET</span>
            <span>Cloudflare relay</span>
          </div>
        </section>

        <main className="workspace">
          <div className="send-column">
        {!showWaiting && (
          <section className="card send-card">
            <div className="card-head">
              <div>
                <h2>Send</h2>
                <p>{sendContentMode === "text" ? `Text message · ${formatSize(textSize)}` : `${files.length} files · ${formatSize(totalSize)}`}</p>
              </div>
              {(textValue || files.length > 0) && (
                <button className="subtle-btn" type="button" onClick={resetSend}>
                  Reset
                </button>
              )}
            </div>
            <div className="composer">
              <div className="content-tabs">
                <button
                  type="button"
                  className={sendContentMode === "text" ? "active" : ""}
                  onClick={() => {
                    setSendContentMode("text");
                    setSendError("");
                    setSendMessage("");
                  }}
                >
                  Text
                </button>
                <button
                  type="button"
                  className={sendContentMode === "files" ? "active" : ""}
                  onClick={() => {
                    setSendContentMode("files");
                    setSendError("");
                    setSendMessage("");
                  }}
                >
                  Files
                </button>
              </div>

              {sendContentMode === "text" ? (
                <div className="text-send">
                  <textarea
                    className="text-composer"
                    value={textValue}
                    disabled={isSending}
                    onChange={(event) => {
                      setTextValue(event.target.value);
                      setSendError("");
                      setSendMessage("");
                    }}
                    placeholder="Paste text, JSON, logs, shell output, or a config snippet"
                  />
                </div>
              ) : files.length === 0 ? (
                <div className="file-drop">
                  <button className="file-pick-btn" type="button" onClick={openPicker}>
                    Choose files
                  </button>
                  <p>No files selected</p>
                </div>
              ) : (
                <>
                  <div className="composer-head">
                    <div>
                      <h3>Files</h3>
                      <p>
                        Total {files.length} files · {formatSize(totalSize)}
                      </p>
                    </div>
                    <button className="subtle-btn" type="button" onClick={openPicker}>
                      Add
                    </button>
                  </div>

                  <div className="file-list">
                    {files.map((file, index) => (
                      <div className="file-row" key={`${file.name}-${index}`}>
                        <span>{file.name}</span>
                        <span>{formatSize(file.size)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="mode-tabs">
                <button
                  type="button"
                  className={mode === "direct" ? "active" : ""}
                  onClick={() => setMode("direct")}
                >
                  Direct
                </button>
                <button
                  type="button"
                  className={mode === "link" ? "active" : ""}
                  onClick={() => setMode("link")}
                >
                  Link
                </button>
                <button type="button" className="disabled" disabled>
                  Email
                </button>
              </div>

              <button className="send-btn" type="button" onClick={startSend} disabled={isSending}>
                {isSending ? "Sending..." : "Create transfer"}
              </button>

              {sendError && <p className="err">{sendError}</p>}
              {sendMessage && <p className="ok">{sendMessage}</p>}
            </div>
          </section>
        )}

        {showWaiting && session && (
          <section className="card waiting-card">
            <div className="wait-head">
              <button type="button" className="back-btn" onClick={resetSend}>
                ←
              </button>
              <div>
              <h2>Waiting...</h2>
                <p>
                  Enter the 6-digit key on the receiving device
                  <br />
                  Expires in <strong>{Math.floor(secondsLeft / 60).toString().padStart(2, "0")}:{(secondsLeft % 60).toString().padStart(2, "0")}</strong>
                </p>
              </div>
            </div>

            <div className="digits">
              {session.key.split("").map((digit, idx) => (
                <span key={`${digit}-${idx}`}>{digit}</span>
              ))}
            </div>

            <div className="qr-wrap">
              <QRCodeSVG value={session.qr_payload} size={172} />
            </div>

            <div className="link-box">
              <input type="text" readOnly value={currentLink} />
              <button type="button" onClick={() => void copyLink()}>
                Copy Link
              </button>
            </div>
            {copyMessage && <p className="status-line">{copyMessage}</p>}

            <p className="status-line">Status: {sessionStatus || session.status}</p>
            {sendError && <p className="err">{sendError}</p>}
            {sendMessage && <p className="ok">{sendMessage}</p>}
          </section>
        )}
          </div>

          <div className="receive-column">
        <section className="card receive-card">
          <div className="card-head">
            <div>
              <h2>Receive</h2>
              <p>{receivedText ? receivedTextFilename || TEXT_FILENAME : "Enter a 6-digit key or open a shared link"}</p>
            </div>
          </div>
          <div className="receive-input-row">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={receiveKey}
              disabled={isReceiving}
              onChange={(event) => setReceiveKey(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
            />
              <button
                type="button"
                onClick={() => void startReceive()}
                disabled={isReceiving}
                aria-label="Receive transfer"
                title="Receive transfer"
              >
                {isReceiving ? <span className="spinner" aria-label="Downloading" /> : "⇩"}
              </button>
          </div>
          {isReceiving && <p className="status-line">Downloading...</p>}
          {receiveError && <p className="err">{receiveError}</p>}
          {receiveMessage && <p className="ok">{receiveMessage}</p>}
          {receivedText && (
            <div className="text-preview">
              <div className="text-preview-actions">
                <span>{receivedTextFilename || TEXT_FILENAME}</span>
                <button type="button" onClick={() => void copyTextToClipboard(receivedText)}>
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadText(
                      receivedText,
                      receivedTextFilename || TEXT_FILENAME,
                      receivedTextContentType
                    )
                  }
                >
                  Download
                </button>
              </div>
              <pre>{receivedText}</pre>
            </div>
          )}
        </section>
          </div>
        </main>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onSelectFiles}
        />

        <section className="seo-content" aria-label="About Shuttle Piping">
          <article>
            <h2>Temporary text and file transfer for everyday handoff</h2>
            <p>
              Shuttle Piping is a lightweight Cloudflare Workers rendezvous tool for moving text,
              code snippets, terminal output, configuration content, and small files across devices.
              It fits quick browser-to-browser sharing, phone-to-laptop handoff, and container-to-host
              curl transfer.
            </p>
          </article>
          <article>
            <h3>Common use cases</h3>
            <ul>
              <li>Send a code snippet, JSON payload, shell output, or config file to another screen.</li>
              <li>Move a small file between phone, laptop, browser, container, and terminal.</li>
              <li>Share with a 6-digit key, receive link, QR code, or curl-compatible path.</li>
              <li>Use short-lived rendezvous sessions without creating an account.</li>
            </ul>
          </article>
          <article>
            <h3>Searches this tool answers</h3>
            <p>
              Temporary text sharing, QR file transfer, curl file sharing, browser file transfer,
              accountless file transfer, send logs between devices, and P2P-style file handoff.
            </p>
          </article>
        </section>

        <section className="howto-section" aria-label="How to use Shuttle Piping">
          <div className="section-head">
            <p className="eyebrow">How it works</p>
            <h2>Send text or a small file in three short steps</h2>
          </div>
          <div className="howto-grid">
            <article>
              <span>01</span>
              <h3>Paste or choose</h3>
              <p>Paste text, JSON, logs, shell output, a config snippet, or choose a small file.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Create a handoff</h3>
              <p>Generate a short-lived key, receive link, or QR code for the other device.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Receive anywhere</h3>
              <p>Open the link, scan the QR code, enter the key, or use curl from a terminal.</p>
            </article>
          </div>
        </section>

        <section className="curl-section" aria-label="Curl file transfer example">
          <div>
            <p className="eyebrow">Terminal workflow</p>
            <h2>Curl-friendly file and text transfer</h2>
            <p>
              Use the same unique path on both sides. This keeps terminal, SSH, Docker, and server
              workflows simple when a browser upload form is not available.
            </p>
          </div>
          <pre>{`echo "hello" | curl -T - https://p2p.gorustai.com/YOUR-TRANSFER-NAME
curl https://p2p.gorustai.com/YOUR-TRANSFER-NAME`}</pre>
        </section>

        <section className="faq-section" aria-label="Shuttle Piping FAQ">
          <div className="section-head">
            <p className="eyebrow">FAQ</p>
            <h2>Fast answers for searchers and AI crawlers</h2>
          </div>
          <div className="faq-grid">
            <article>
              <h3>Is Shuttle Piping true peer-to-peer?</h3>
              <p>
                It provides a P2P-style handoff workflow, but transfers are relayed through
                Cloudflare Workers and Durable Objects rather than direct WebRTC browser-to-browser
                connectivity.
              </p>
            </article>
            <article>
              <h3>Can I use it with curl?</h3>
              <p>
                Yes. Send with curl PUT or POST to a unique path, then receive with curl GET from
                the same path. This is useful for terminals, containers, and servers.
              </p>
            </article>
            <article>
              <h3>What should I transfer?</h3>
              <p>
                Use it for text, logs, code snippets, configuration content, and small files within
                Cloudflare request upload limits.
              </p>
            </article>
            <article>
              <h3>Does it need an account?</h3>
              <p>
                No account is required. Browser sessions use short-lived keys, links, or QR codes,
                and terminal transfers use a shared unique path.
              </p>
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
