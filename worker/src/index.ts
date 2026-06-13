type TransferMode = "direct" | "link";
type SessionState =
  | "reserved"
  | "sender_waiting"
  | "receiver_waiting"
  | "active"
  | "completed"
  | "expired";

interface Env {
  ASSETS: Fetcher;
  TRANSFER_OBJECT: DurableObjectNamespace;
}

interface SessionMetadata {
  file_names?: string[];
  total_size?: number;
  archive_name?: string;
  mime_type?: string;
}

interface SessionRecord {
  key: string;
  mode: TransferMode;
  state: SessionState;
  metadata?: SessionMetadata;
  expiresAt: number;
  completedAt?: number;
}

interface CreateSessionRequest {
  mode?: TransferMode;
  metadata?: SessionMetadata;
}

interface ReserveResponse {
  key: string;
  mode: TransferMode;
  status: SessionState;
  expires_at: string;
  metadata?: SessionMetadata;
}

interface StatusResponse extends ReserveResponse {
  seconds_left: number;
}

interface Completion {
  bytes: number;
}

interface WaitingSender {
  name: string;
  body: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  contentDisposition: string | null;
  contentLength: string | null;
  xPiping: string | null;
  paired: Deferred<void>;
  completed: Deferred<Completion>;
  createdAt: number;
}

const SESSION_KEY_LEN = 6;
const SESSION_TTL_MS = 10 * 60 * 1000;
const COMPLETED_SESSION_RETENTION_MS = 5 * 60 * 1000;
const MANUAL_PAIRING_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TRANSFER_NAME_LEN = 512;

const INTERNAL_RESERVE_PATH = "/__do/reserve";
const INTERNAL_STATUS_PATH = "/__do/status";
const INTERNAL_TRANSFER_PATH = "/__do/transfer";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  setCorsHeaders(headers);
  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "text/plain; charset=utf-8");
  setCorsHeaders(headers);
  return new Response(body, {
    ...init,
    headers
  });
}

function setCorsHeaders(headers: Headers): void {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, content-disposition, x-piping");
  headers.set("access-control-expose-headers", "content-type, content-length, content-disposition, x-piping");
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, content-disposition, x-piping",
      "access-control-max-age": "86400"
    }
  });
}

function validateSessionKey(key: string): boolean {
  return key.length === SESSION_KEY_LEN && /^\d+$/.test(key);
}

function generateSessionKey(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return value.toString().padStart(SESSION_KEY_LEN, "0");
}

function normalizeTransferName(pathname: string): string | null {
  const trimmed = pathname.replace(/^\/+/, "");
  if (!trimmed || trimmed.length > MAX_TRANSFER_NAME_LEN) {
    return null;
  }

  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\")
    )
  ) {
    return null;
  }

  return trimmed;
}

function isStaticAppPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/app" ||
    pathname.startsWith("/app/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/llms.txt" ||
    pathname.startsWith("/assets/")
  );
}

function isReservedTransferPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname === "/status" ||
    isStaticAppPath(pathname)
  );
}

function linkUrlFromRequest(request: Request, key: string): string {
  const url = new URL(request.url);
  url.pathname = "/app";
  url.search = `mode=link&key=${encodeURIComponent(key)}`;
  return url.toString();
}

function withLink<T extends ReserveResponse | StatusResponse>(payload: T, request: Request): T & {
  link_url: string;
  qr_payload: string;
} {
  const linkUrl = linkUrlFromRequest(request, payload.key);
  return {
    ...payload,
    link_url: linkUrl,
    qr_payload: linkUrl
  };
}

function expiresAtIso(expiresAt: number): string {
  return new Date(expiresAt).toISOString();
}

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function sanitizeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}

function contentDispositionFromMetadata(metadata?: SessionMetadata): string | null {
  const filename = metadata?.archive_name;
  if (!filename) {
    return null;
  }
  return `attachment; filename="${sanitizeFilename(filename)}"`;
}

function safeMetadata(value: unknown): SessionMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const metadata: SessionMetadata = {};

  if (Array.isArray(record.file_names)) {
    metadata.file_names = record.file_names.filter((item): item is string => typeof item === "string");
  }
  if (typeof record.total_size === "number" && Number.isFinite(record.total_size)) {
    metadata.total_size = record.total_size;
  }
  if (typeof record.archive_name === "string") {
    metadata.archive_name = record.archive_name;
  }
  if (typeof record.mime_type === "string") {
    metadata.mime_type = record.mime_type;
  }

  return metadata;
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/app" || url.pathname.startsWith("/app/")) {
    url.pathname = "/";
    url.search = "";
    return env.ASSETS.fetch(new Request(url, request));
  }
  return env.ASSETS.fetch(request);
}

function durableObjectFor(env: Env, name: string): DurableObjectStub {
  return env.TRANSFER_OBJECT.get(env.TRANSFER_OBJECT.idFromName(name));
}

function internalRequest(request: Request, path: string, init: RequestInit = {}): Request {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  return new Request(url, init);
}

async function createSession(request: Request, env: Env): Promise<Response> {
  let payload: CreateSessionRequest = {};
  try {
    payload = (await request.json()) as CreateSessionRequest;
  } catch {
    payload = {};
  }

  const mode: TransferMode = payload.mode === "link" ? "link" : "direct";
  const metadata = safeMetadata(payload.metadata);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const key = generateSessionKey();
    const stub = durableObjectFor(env, key);
    const reserveRequest = internalRequest(request, INTERNAL_RESERVE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ key, mode, metadata })
    });

    const response = await stub.fetch(reserveRequest);
    if (response.status === 409) {
      continue;
    }
    if (!response.ok) {
      return response;
    }

    const reserved = (await response.json()) as ReserveResponse;
    return jsonResponse(withLink(reserved, request), { status: 201 });
  }

  return textResponse("Unable to allocate transfer key, please retry", { status: 503 });
}

async function getSessionStatus(request: Request, env: Env, key: string): Promise<Response> {
  if (!validateSessionKey(key)) {
    return textResponse("Session key must be 6 digits", { status: 400 });
  }

  const response = await durableObjectFor(env, key).fetch(
    internalRequest(request, INTERNAL_STATUS_PATH, { method: "GET" })
  );
  if (!response.ok) {
    return response;
  }

  const status = (await response.json()) as StatusResponse;
  return jsonResponse(withLink(status, request), { status: response.status });
}

async function transferRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (isReservedTransferPath(url.pathname)) {
    return textResponse("Reserved path", { status: 404 });
  }

  const name = normalizeTransferName(url.pathname);
  if (!name) {
    return textResponse("Transfer path is invalid", { status: 400 });
  }

  const receiverCount = Number.parseInt(url.searchParams.get("n") ?? "1", 10);
  if (!Number.isFinite(receiverCount) || receiverCount !== 1) {
    return textResponse("Only one receiver is supported on the Cloudflare Worker backend\n", {
      status: 400
    });
  }

  const headers = new Headers(request.headers);
  headers.set("x-transfer-name", name);
  const doRequest = internalRequest(request, INTERNAL_TRANSFER_PATH, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body
  });

  return durableObjectFor(env, name).fetch(doRequest);
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return optionsResponse();
  }

  if ((request.method === "GET" || request.method === "HEAD") && isStaticAppPath(url.pathname)) {
    return serveAsset(request, env);
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/status") {
    const statusPayload = {
      status: "healthy",
      version: "4.0.0-cf-worker",
      backend: "cloudflare-worker-durable-object",
      max_request_body: "Cloudflare account upload limit applies",
      session_ttl: "10 minutes"
    };

    if (request.method === "HEAD") {
      return new Response(null, {
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      });
    }

    return jsonResponse(statusPayload);
  }

  if (request.method === "POST" && url.pathname === "/api/session") {
    return createSession(request, env);
  }

  const statusMatch = url.pathname.match(/^\/api\/session\/(\d{6})$/);
  if (request.method === "GET" && statusMatch) {
    return getSessionStatus(request, env, statusMatch[1]);
  }

  if (request.method === "GET" || request.method === "PUT" || request.method === "POST") {
    return transferRequest(request, env);
  }

  return textResponse(`Unsupported method: ${request.method}\n`, {
    status: 405,
    headers: {
      allow: "GET, POST, PUT, OPTIONS"
    }
  });
}

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;

export class TransferObject implements DurableObject {
  private session: SessionRecord | null | undefined;
  private senderWaiting: WaitingSender | null = null;
  private receiverWaiting: Deferred<WaitingSender> | null = null;
  private active = false;

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === INTERNAL_RESERVE_PATH && request.method === "POST") {
      return this.reserve(request);
    }

    if (url.pathname === INTERNAL_STATUS_PATH && request.method === "GET") {
      return this.status();
    }

    if (url.pathname === INTERNAL_TRANSFER_PATH) {
      if (request.method === "GET") {
        return this.receiver(request);
      }
      if (request.method === "PUT" || request.method === "POST") {
        return this.sender(request);
      }
    }

    return textResponse("Not found", { status: 404 });
  }

  private async loadSession(): Promise<SessionRecord | null> {
    if (this.session !== undefined) {
      return this.session;
    }
    this.session = (await this.state.storage.get<SessionRecord>("session")) ?? null;
    return this.session;
  }

  private async saveSession(session: SessionRecord | null): Promise<void> {
    this.session = session;
    if (session) {
      await this.state.storage.put("session", session);
    } else {
      await this.state.storage.delete("session");
    }
  }

  private async reserve(request: Request): Promise<Response> {
    const body = (await request.json()) as CreateSessionRequest & { key?: string };
    const key = typeof body.key === "string" ? body.key : "";
    if (!validateSessionKey(key)) {
      return textResponse("Session key must be 6 digits", { status: 400 });
    }

    const existing = await this.loadSession();
    if (existing && !this.isExpired(existing) && !this.isCompletedPastRetention(existing)) {
      return textResponse("Session already exists", { status: 409 });
    }
    if (this.senderWaiting || this.receiverWaiting || this.active) {
      return textResponse("Transfer key already in use", { status: 409 });
    }

    const session: SessionRecord = {
      key,
      mode: body.mode === "link" ? "link" : "direct",
      state: "reserved",
      metadata: safeMetadata(body.metadata),
      expiresAt: Date.now() + SESSION_TTL_MS
    };

    await this.saveSession(session);
    return jsonResponse(this.sessionPayload(session), { status: 201 });
  }

  private async status(): Promise<Response> {
    const session = await this.loadSession();
    if (!session) {
      return textResponse("Session not found", { status: 404 });
    }

    if (this.isCompletedPastRetention(session)) {
      await this.saveSession(null);
      return textResponse("Session not found", { status: 404 });
    }

    if (this.isExpired(session)) {
      session.state = "expired";
      await this.saveSession(session);
      return textResponse("Session expired", { status: 410 });
    }

    return jsonResponse({
      ...this.sessionPayload(session),
      seconds_left: secondsLeft(session.expiresAt)
    });
  }

  private async sender(request: Request): Promise<Response> {
    const name = request.headers.get("x-transfer-name") ?? "";
    if (!name) {
      return textResponse("Transfer path is invalid", { status: 400 });
    }

    const session = await this.prepareSessionState(name, "sender_waiting");
    if (session instanceof Response) {
      return session;
    }

    if (this.senderWaiting) {
      return textResponse("Another sender has been connected on this path\n", { status: 409 });
    }
    if (this.active) {
      return textResponse("Connection on this path has been established already\n", { status: 409 });
    }

    const sender: WaitingSender = {
      name,
      body: request.body,
      contentType: request.headers.get("content-type"),
      contentDisposition: request.headers.get("content-disposition"),
      contentLength: request.headers.get("content-length"),
      xPiping: request.headers.get("x-piping"),
      paired: new Deferred<void>(),
      completed: new Deferred<Completion>(),
      createdAt: Date.now()
    };

    if (this.receiverWaiting) {
      const receiver = this.receiverWaiting;
      this.receiverWaiting = null;
      this.active = true;
      await this.updateSessionState("active");
      sender.paired.resolve();
      receiver.resolve(sender);
    } else {
      this.senderWaiting = sender;
    }

    const pairingTimeout = this.currentPairingTimeout();
    try {
      await timeout(sender.paired.promise, pairingTimeout, "Timeout waiting for receiver");
    } catch {
      if (this.senderWaiting === sender) {
        this.senderWaiting = null;
      }
      await this.updateSessionState("expired");
      return textResponse("Timeout waiting for receiver\n", { status: 408 });
    }

    try {
      const completion = await timeout(sender.completed.promise, TRANSFER_TIMEOUT_MS, "Transfer timeout");
      await this.markCompleted();
      const seconds = Math.max(0.001, (Date.now() - sender.createdAt) / 1000);
      const speed = completion.bytes / seconds / 1024 / 1024;
      return textResponse(`Transfer completed: ${completion.bytes} bytes (${speed.toFixed(2)} MB/s)\n`);
    } catch {
      await this.updateSessionState("expired");
      return textResponse("Transfer failed\n", { status: 500 });
    } finally {
      if (this.senderWaiting === sender) {
        this.senderWaiting = null;
      }
      this.active = false;
    }
  }

  private async receiver(request: Request): Promise<Response> {
    const name = request.headers.get("x-transfer-name") ?? "";
    if (!name) {
      return textResponse("Transfer path is invalid", { status: 400 });
    }

    const session = await this.prepareSessionState(name, "receiver_waiting");
    if (session instanceof Response) {
      return session;
    }

    if (this.receiverWaiting) {
      return textResponse("Another receiver has been connected on this path\n", { status: 409 });
    }
    if (this.active) {
      return textResponse("Connection on this path has been established already\n", { status: 409 });
    }

    let sender: WaitingSender;
    if (this.senderWaiting) {
      sender = this.senderWaiting;
      this.senderWaiting = null;
      this.active = true;
      await this.updateSessionState("active");
      sender.paired.resolve();
    } else {
      const receiver = new Deferred<WaitingSender>();
      this.receiverWaiting = receiver;
      try {
        sender = await timeout(receiver.promise, this.currentPairingTimeout(), "Timeout waiting for sender");
      } catch {
        if (this.receiverWaiting === receiver) {
          this.receiverWaiting = null;
        }
        await this.updateSessionState("expired");
        return textResponse("Timeout waiting for sender\n", { status: 408 });
      }
    }

    return this.receiverResponse(sender);
  }

  private receiverResponse(sender: WaitingSender): Response {
    const session = this.session ?? undefined;
    const headers = new Headers();
    setCorsHeaders(headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("cache-control", "no-cache, no-store, must-revalidate");

    const contentType = sender.contentType ?? session?.metadata?.mime_type ?? "application/octet-stream";
    headers.set("content-type", contentType);

    const contentDisposition =
      sender.contentDisposition ?? contentDispositionFromMetadata(session?.metadata);
    if (contentDisposition) {
      headers.set("content-disposition", contentDisposition);
    }
    if (sender.contentLength) {
      headers.set("content-length", sender.contentLength);
    }
    if (sender.xPiping) {
      headers.set("x-piping", sender.xPiping);
    }

    const body = streamWithCompletion(sender.body, sender.completed);
    return new Response(body, {
      status: 200,
      headers
    });
  }

  private async prepareSessionState(name: string, nextState: SessionState): Promise<SessionRecord | Response | null> {
    const session = await this.loadSession();
    if (!session) {
      return null;
    }

    if (session.key !== name) {
      return null;
    }

    if (this.isExpired(session)) {
      session.state = "expired";
      await this.saveSession(session);
      return textResponse("Transfer key expired", { status: 410 });
    }

    if (session.state === "completed" || session.state === "expired") {
      return textResponse("Transfer key is no longer available", { status: 410 });
    }

    session.state = nextState;
    await this.saveSession(session);
    return session;
  }

  private async updateSessionState(state: SessionState): Promise<void> {
    const session = await this.loadSession();
    if (!session) {
      return;
    }
    session.state = state;
    await this.saveSession(session);
  }

  private async markCompleted(): Promise<void> {
    const session = await this.loadSession();
    if (!session) {
      return;
    }
    session.state = "completed";
    session.completedAt = Date.now();
    await this.saveSession(session);
  }

  private currentPairingTimeout(): number {
    const session = this.session;
    if (!session) {
      return MANUAL_PAIRING_TIMEOUT_MS;
    }
    return Math.max(1, Math.min(MANUAL_PAIRING_TIMEOUT_MS, session.expiresAt - Date.now()));
  }

  private isExpired(session: SessionRecord): boolean {
    return session.state !== "active" && session.state !== "completed" && Date.now() >= session.expiresAt;
  }

  private isCompletedPastRetention(session: SessionRecord): boolean {
    return (
      session.state === "completed" &&
      typeof session.completedAt === "number" &&
      Date.now() - session.completedAt > COMPLETED_SESSION_RETENTION_MS
    );
  }

  private sessionPayload(session: SessionRecord): ReserveResponse {
    return {
      key: session.key,
      mode: session.mode,
      status: session.state,
      expires_at: expiresAtIso(session.expiresAt),
      metadata: session.metadata
    };
  }
}

function streamWithCompletion(
  body: ReadableStream<Uint8Array> | null,
  completed: Deferred<Completion>
): ReadableStream<Uint8Array> {
  if (!body) {
    completed.resolve({ bytes: 0 });
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });
  }

  const reader = body.getReader();
  let bytes = 0;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finished = true;
          completed.resolve({ bytes });
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        controller.enqueue(result.value);
      } catch (error) {
        finished = true;
        completed.reject(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!finished) {
        finished = true;
        completed.reject(reason);
      }
      return reader.cancel(reason);
    }
  });
}
