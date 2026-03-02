import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type TransferMode = "direct" | "link";

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

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );

  const openPicker = () => fileInputRef.current?.click();

  const resetSend = () => {
    setFiles([]);
    setSession(null);
    setSessionStatus("");
    setSecondsLeft(0);
    setSendError("");
    setSendMessage("");
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
      setIsReceiving(true);

      try {
        const response = await fetch(`/${key}`);
        if (!response.ok) {
          throw new Error(await response.text());
        }

        const blob = await response.blob();
        const filename =
          parseDispositionFilename(response.headers.get("content-disposition")) ||
          `transfer-${key}.bin`;

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
    if (files.length === 0 || isSending) {
      return;
    }

    setSendError("");
    setSendMessage("");
    setIsSending(true);

    try {
      const uploadPayload = await buildUploadPayload(files);
      const metadata: SessionMetadata = {
        file_names: uploadPayload.fileNames,
        total_size: uploadPayload.totalSize,
        archive_name: uploadPayload.archiveName,
        mime_type: uploadPayload.contentType
      };

      const createdSession = await createSession(mode, metadata);
      setSession(createdSession);
      setSessionStatus(createdSession.status);

      const uploadResponse = await fetch(`/${createdSession.key}`, {
        method: "PUT",
        headers: {
          "Content-Type": uploadPayload.contentType,
          "Content-Disposition": `attachment; filename="${uploadPayload.archiveName.replace(/"/g, "_")}"`
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

  return (
    <div className="page-bg">
      <div className="page-shell">
        {!showWaiting && (
          <section className="card send-card" onClick={files.length === 0 ? openPicker : undefined}>
            <h2>Send</h2>
            {files.length === 0 ? (
              <div className="plus-wrap">
                <button className="plus-btn" type="button" onClick={openPicker}>
                  +
                </button>
              </div>
            ) : (
              <div className="composer">
                <div className="composer-head">
                  <button className="inline-add" type="button" onClick={openPicker}>
                    +
                  </button>
                  <div>
                    <h3>Add more</h3>
                    <p>
                      Total {files.length} files · {formatSize(totalSize)}
                    </p>
                  </div>
                  <button className="ghost-btn" type="button" onClick={resetSend}>
                    Reset
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
                  {isSending ? "Sending..." : "Send"}
                </button>

                {sendError && <p className="err">{sendError}</p>}
                {sendMessage && <p className="ok">{sendMessage}</p>}
              </div>
            )}
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

            <p className="status-line">Status: {sessionStatus || session.status}</p>
            {sendError && <p className="err">{sendError}</p>}
            {sendMessage && <p className="ok">{sendMessage}</p>}
          </section>
        )}

        <section className="card receive-card">
          <h2>Receive</h2>
          <div className="receive-input-row">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={receiveKey}
              onChange={(event) => setReceiveKey(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Input key"
            />
            <button type="button" onClick={() => void startReceive()} disabled={isReceiving}>
              {isReceiving ? "..." : "⇩"}
            </button>
          </div>
          {receiveError && <p className="err">{receiveError}</p>}
          {receiveMessage && <p className="ok">{receiveMessage}</p>}
        </section>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onSelectFiles}
        />
      </div>
    </div>
  );
}

export default App;
