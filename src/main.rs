use {
  axum::{
    Router,
    body::Body,
    extract::{
      Json,
      Path,
      State,
    },
    http::{
      HeaderMap,
      HeaderValue,
      StatusCode,
      header,
    },
    response::{
      IntoResponse,
      Response,
    },
    routing::{
      get,
      post,
      put,
    },
  },
  chrono::{
    DateTime,
    Utc,
  },
  futures_util::StreamExt,
  include_dir::{
    Dir,
    include_dir,
  },
  parking_lot::Mutex,
  rand::{
    Rng,
    thread_rng,
  },
  serde::{
    Deserialize,
    Serialize,
  },
  std::{
    collections::{
      HashMap,
      HashSet,
    },
    sync::Arc,
    time::{
      Duration,
      Instant,
    },
  },
  tokio::sync::oneshot,
  tracing::{
    error,
    info,
    warn,
  },
  tracing_subscriber::EnvFilter,
};

const MAX_WAIT_TIME: Duration = Duration::from_secs(60 * 60); // 1 hour
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60); // 1 minute
const MAX_TRANSFER_ID_LEN: usize = 128;
const SESSION_KEY_LEN: usize = 6;
const SESSION_TTL: Duration = Duration::from_secs(10 * 60); // 10 minutes
const COMPLETED_SESSION_RETENTION: Duration = Duration::from_secs(5 * 60); // 5 minutes

static WEB_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

// --- Core types ---

/// Data delivered from sender to receiver through a oneshot channel.
struct SenderData {
  body: Body,
  content_type: Option<HeaderValue>,
  content_disposition: Option<HeaderValue>,
  completed_tx: oneshot::Sender<u64>,
}

/// Coordination slot stored in the map.
/// The first party to arrive inserts a slot; the second party removes it.
enum TransferSlot {
  /// Sender arrived first. Body is delivered through the oneshot (already sent or will be sent).
  SenderWaiting {
    body_rx: oneshot::Receiver<SenderData>,
    created_at: Instant,
  },
  /// Receiver arrived first. Sender should deliver its body through body_tx.
  ReceiverWaiting {
    body_tx: oneshot::Sender<SenderData>,
    created_at: Instant,
  },
}

impl TransferSlot {
  fn created_at(&self) -> Instant {
    match self {
      Self::SenderWaiting { created_at, .. } | Self::ReceiverWaiting { created_at, .. } => *created_at,
    }
  }

  fn kind(&self) -> &'static str {
    match self {
      Self::SenderWaiting { .. } => "sender_waiting",
      Self::ReceiverWaiting { .. } => "receiver_waiting",
    }
  }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
enum SessionMode {
  #[default]
  Direct,
  Link,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SessionState {
  Reserved,
  SenderWaiting,
  ReceiverWaiting,
  Active,
  Completed,
  Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionMetadata {
  #[serde(default)]
  file_names: Vec<String>,
  total_size: Option<u64>,
  archive_name: Option<String>,
  mime_type: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionInfo {
  key: String,
  mode: SessionMode,
  state: SessionState,
  metadata: Option<SessionMetadata>,
  expires_at: DateTime<Utc>,
  expires_at_instant: Instant,
  completed_at: Option<Instant>,
}

impl SessionInfo {
  fn is_expired_for_pairing(&self) -> bool {
    self.state != SessionState::Active
      && self.state != SessionState::Completed
      && Instant::now() >= self.expires_at_instant
  }
}

#[derive(Debug, Deserialize, Default)]
struct CreateSessionRequest {
  #[serde(default)]
  mode: SessionMode,
  metadata: Option<SessionMetadata>,
}

#[derive(Debug, Serialize)]
struct CreateSessionResponse {
  key: String,
  mode: SessionMode,
  status: SessionState,
  expires_at: String,
  link_url: String,
  qr_payload: String,
}

#[derive(Debug, Serialize)]
struct SessionStatusResponse {
  key: String,
  mode: SessionMode,
  status: SessionState,
  expires_at: String,
  seconds_left: i64,
  metadata: Option<SessionMetadata>,
  link_url: String,
}

// --- Transfer manager ---

#[derive(Clone)]
struct TransferManager {
  // Single lock for the coordination map (parking_lot for better performance).
  // Body and oneshot types are Send but !Sync, so DashMap cannot be used.
  // The lock is only held for brief insert/remove/lookup — never across await points.
  transfers: Arc<Mutex<HashMap<String, TransferSlot>>>,
  sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
}

impl TransferManager {
  fn new() -> Self {
    Self {
      transfers: Arc::new(Mutex::new(HashMap::new())),
      sessions: Arc::new(Mutex::new(HashMap::new())),
    }
  }

  fn start_cleanup_task(&self) {
    let transfers = self.transfers.clone();
    let sessions = self.sessions.clone();
    tokio::spawn(async move {
      let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
      loop {
        interval.tick().await;

        let mut expired_session_keys = Vec::new();
        let removed_sessions = {
          let mut map = sessions.lock();
          let now = Instant::now();
          let before = map.len();
          map.retain(|key, session| {
            if session.state == SessionState::Completed {
              let keep = session
                .completed_at
                .map(|completed_at| completed_at.elapsed() <= COMPLETED_SESSION_RETENTION)
                .unwrap_or(false);
              if !keep {
                info!("Cleaning completed session: {}", key);
              }
              return keep;
            }

            if now >= session.expires_at_instant && session.state != SessionState::Active {
              expired_session_keys.push(key.clone());
              warn!("Cleaning expired session: {}", key);
              return false;
            }

            true
          });
          before - map.len()
        };

        let expired_set: HashSet<String> = expired_session_keys.into_iter().collect();
        let removed_transfers = {
          let mut map = transfers.lock();
          let before = map.len();
          map.retain(|id, slot| {
            let expired_by_session = expired_set.contains(id);
            let expired_by_wait = slot.created_at().elapsed() > MAX_WAIT_TIME;
            if expired_by_wait {
              warn!("Cleaning expired transfer: {}", id);
            }
            !(expired_by_session || expired_by_wait)
          });
          before - map.len()
        };

        if removed_sessions > 0 {
          info!("Cleaned {} expired/completed sessions", removed_sessions);
        }
        if removed_transfers > 0 {
          info!("Cleaned {} expired transfers", removed_transfers);
        }
      }
    });
  }

  fn create_session(&self, mode: SessionMode, metadata: Option<SessionMetadata>) -> Result<SessionInfo, &'static str> {
    for _ in 0 .. 200 {
      let candidate = generate_session_key();

      if self.transfers.lock().contains_key(&candidate) {
        continue;
      }

      let mut sessions = self.sessions.lock();
      if sessions.contains_key(&candidate) {
        continue;
      }

      let created_at = Utc::now();
      let created_at_instant = Instant::now();
      let expires_at = created_at + chrono::Duration::seconds(SESSION_TTL.as_secs() as i64);
      let expires_at_instant = created_at_instant + SESSION_TTL;

      let session = SessionInfo {
        key: candidate.clone(),
        mode,
        state: SessionState::Reserved,
        metadata,
        expires_at,
        expires_at_instant,
        completed_at: None,
      };

      sessions.insert(candidate, session.clone());
      return Ok(session);
    }

    Err("Unable to allocate transfer key, please retry")
  }

  fn get_session(&self, key: &str) -> Option<SessionInfo> {
    self.sessions.lock().get(key).cloned()
  }

  fn get_metadata(&self, key: &str) -> Option<SessionMetadata> {
    self
      .sessions
      .lock()
      .get(key)
      .and_then(|session| session.metadata.clone())
  }

  fn session_pairing_timeout(&self, key: &str) -> Duration {
    let session = self.sessions.lock().get(key).cloned();
    if let Some(session) = session {
      let now = Instant::now();
      let ttl_left = session.expires_at_instant.saturating_duration_since(now);
      ttl_left.min(MAX_WAIT_TIME)
    } else {
      MAX_WAIT_TIME
    }
  }

  fn prepare_sender_for_session(&self, key: &str) -> Result<(), (StatusCode, &'static str)> {
    self.prepare_session_state(key, SessionState::SenderWaiting)
  }

  fn prepare_receiver_for_session(&self, key: &str) -> Result<(), (StatusCode, &'static str)> {
    self.prepare_session_state(key, SessionState::ReceiverWaiting)
  }

  fn prepare_session_state(&self, key: &str, next_state: SessionState) -> Result<(), (StatusCode, &'static str)> {
    let mut sessions = self.sessions.lock();
    let Some(session) = sessions.get_mut(key) else {
      return Ok(());
    };

    if session.is_expired_for_pairing() {
      session.state = SessionState::Expired;
      return Err((StatusCode::GONE, "Transfer key expired"));
    }

    if matches!(session.state, SessionState::Completed | SessionState::Expired) {
      return Err((StatusCode::GONE, "Transfer key is no longer available"));
    }

    session.state = next_state;
    Ok(())
  }

  fn mark_session_active(&self, key: &str) {
    if let Some(session) = self.sessions.lock().get_mut(key) {
      session.state = SessionState::Active;
    }
  }

  fn mark_session_completed(&self, key: &str) {
    if let Some(session) = self.sessions.lock().get_mut(key) {
      session.state = SessionState::Completed;
      session.completed_at = Some(Instant::now());
    }
  }

  fn mark_session_expired(&self, key: &str) {
    if let Some(session) = self.sessions.lock().get_mut(key) {
      session.state = SessionState::Expired;
    }
  }

  fn has_active_or_completed_session(&self, key: &str) -> bool {
    self
      .sessions
      .lock()
      .get(key)
      .map(|session| {
        matches!(
          session.state,
          SessionState::Reserved
            | SessionState::SenderWaiting
            | SessionState::ReceiverWaiting
            | SessionState::Active
            | SessionState::Completed
        )
      })
      .unwrap_or(false)
  }
}

// --- Validation ---

fn validate_transfer_id(id: &str) -> Result<(), &'static str> {
  if id.is_empty() {
    return Err("Transfer ID must not be empty");
  }
  if id.len() > MAX_TRANSFER_ID_LEN {
    return Err("Transfer ID too long (max 128 characters)");
  }
  if !id
    .bytes()
    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
  {
    return Err("Transfer ID may only contain [a-zA-Z0-9._-]");
  }
  Ok(())
}

fn validate_session_key(key: &str) -> Result<(), &'static str> {
  if key.len() != SESSION_KEY_LEN || !key.bytes().all(|b| b.is_ascii_digit()) {
    return Err("Session key must be 6 digits");
  }
  Ok(())
}

fn generate_session_key() -> String {
  let mut rng = thread_rng();
  format!("{:06}", rng.gen_range(0 .. 1_000_000))
}

fn set_common_headers(headers: &mut HeaderMap) {
  headers.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
  headers.insert(
    "Cache-Control",
    HeaderValue::from_static("no-cache, no-store, must-revalidate"),
  );
}

fn link_url_from_headers(headers: &HeaderMap, key: &str) -> String {
  let path = format!("/app?mode=link&key={key}");

  let host = headers
    .get("x-forwarded-host")
    .or_else(|| headers.get("host"))
    .and_then(|h| h.to_str().ok());

  let Some(host) = host else {
    return path;
  };

  let scheme = headers
    .get("x-forwarded-proto")
    .and_then(|h| h.to_str().ok())
    .filter(|v| !v.is_empty())
    .unwrap_or_else(|| if host.starts_with("localhost") { "http" } else { "https" });

  format!("{scheme}://{host}{path}")
}

fn sanitize_filename(name: &str) -> String {
  name
    .chars()
    .map(|c| match c {
      '"' | '\\' | '\r' | '\n' => '_',
      _ => c,
    })
    .collect()
}

fn maybe_content_disposition_from_metadata(metadata: Option<SessionMetadata>) -> Option<HeaderValue> {
  let filename = metadata.and_then(|m| m.archive_name).filter(|name| !name.is_empty())?;

  let value = format!("attachment; filename=\"{}\"", sanitize_filename(&filename));
  HeaderValue::from_str(&value).ok()
}

fn web_response_for(path: &str) -> Option<Response> {
  let file = WEB_DIST.get_file(path)?;
  let content_type = mime_guess::from_path(path).first_or_octet_stream();
  let mut response = Response::new(Body::from(file.contents()));
  *response.status_mut() = StatusCode::OK;

  if let Ok(value) = HeaderValue::from_str(content_type.as_ref()) {
    response.headers_mut().insert(header::CONTENT_TYPE, value);
  }

  Some(response)
}

fn normalize_asset_path(path: &str) -> Option<String> {
  let trimmed = path.trim_start_matches('/');
  if trimmed.is_empty() {
    return None;
  }

  if trimmed
    .split('/')
    .any(|segment| segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\'))
  {
    return None;
  }

  Some(trimmed.to_owned())
}

// --- API handlers ---

async fn handle_create_session(
  State(manager): State<TransferManager>,
  headers: HeaderMap,
  Json(request): Json<CreateSessionRequest>,
) -> Response {
  match manager.create_session(request.mode, request.metadata) {
    Ok(session) => {
      let link_url = link_url_from_headers(&headers, &session.key);
      let response = CreateSessionResponse {
        key: session.key,
        mode: session.mode,
        status: session.state,
        expires_at: session.expires_at.to_rfc3339(),
        qr_payload: link_url.clone(),
        link_url,
      };
      (StatusCode::CREATED, Json(response)).into_response()
    }
    Err(msg) => (StatusCode::SERVICE_UNAVAILABLE, msg).into_response(),
  }
}

async fn handle_get_session(
  Path(key): Path<String>,
  State(manager): State<TransferManager>,
  headers: HeaderMap,
) -> Response {
  if let Err(msg) = validate_session_key(&key) {
    return (StatusCode::BAD_REQUEST, msg).into_response();
  }

  let Some(session) = manager.get_session(&key) else {
    return (StatusCode::NOT_FOUND, "Session not found").into_response();
  };

  if session.is_expired_for_pairing() {
    manager.mark_session_expired(&key);
    return (StatusCode::GONE, "Session expired").into_response();
  }

  let now = Utc::now();
  let seconds_left = (session.expires_at - now).num_seconds().max(0);
  let response = SessionStatusResponse {
    key: session.key,
    mode: session.mode,
    status: session.state,
    expires_at: session.expires_at.to_rfc3339(),
    seconds_left,
    metadata: session.metadata,
    link_url: link_url_from_headers(&headers, &key),
  };

  Json(response).into_response()
}

// --- UI handlers ---

async fn handle_app_index() -> Response {
  web_response_for("index.html").unwrap_or_else(|| (StatusCode::NOT_FOUND, "Web app not built").into_response())
}

async fn handle_app_path(Path(path): Path<String>) -> Response {
  let normalized = path.trim_start_matches('/');
  if normalized.is_empty() {
    return handle_app_index().await;
  }

  if let Some(clean_path) = normalize_asset_path(normalized) {
    if let Some(response) = web_response_for(&clean_path) {
      return response;
    }
  }

  // SPA fallback
  handle_app_index().await
}

async fn handle_assets(Path(path): Path<String>) -> Response {
  let Some(clean_path) = normalize_asset_path(&path) else {
    return (StatusCode::BAD_REQUEST, "Invalid asset path").into_response();
  };

  let target = format!("assets/{clean_path}");
  web_response_for(&target).unwrap_or_else(|| (StatusCode::NOT_FOUND, "Asset not found").into_response())
}

// --- Transfer handlers ---

async fn handle_sender(
  Path(id): Path<String>,
  State(manager): State<TransferManager>,
  headers: HeaderMap,
  body: Body,
) -> Response {
  if let Err(msg) = validate_transfer_id(&id) {
    return (StatusCode::BAD_REQUEST, msg).into_response();
  }

  if let Err((status, msg)) = manager.prepare_sender_for_session(&id) {
    return (status, msg).into_response();
  }

  info!("Sender connected: {}", id);

  let content_type = headers.get(header::CONTENT_TYPE).cloned();
  let content_disposition = headers.get(header::CONTENT_DISPOSITION).cloned();
  let (completed_tx, completed_rx) = oneshot::channel::<u64>();
  let sender_data = SenderData {
    body,
    content_type,
    content_disposition,
    completed_tx,
  };

  // Determine action while holding the lock briefly.
  let (body_tx, matched_receiver) = {
    let mut map = manager.transfers.lock();
    match map.get(&id) {
      Some(TransferSlot::SenderWaiting { .. }) => {
        error!("Transfer ID {} already in use", id);
        return (StatusCode::CONFLICT, "Transfer ID already in use").into_response();
      }
      Some(TransferSlot::ReceiverWaiting { .. }) => {
        // Receiver is waiting — take the slot and deliver directly.
        let slot = map.remove(&id).expect("entry exists");
        match slot {
          TransferSlot::ReceiverWaiting { body_tx, .. } => (body_tx, true),
          _ => unreachable!(),
        }
      }
      None => {
        // No one waiting — we are first.
        let (body_tx, body_rx) = oneshot::channel();
        map.insert(id.clone(), TransferSlot::SenderWaiting {
          body_rx,
          created_at: Instant::now(),
        });
        (body_tx, false)
      }
    }
  }; // lock released

  if matched_receiver {
    manager.mark_session_active(&id);
  }

  // Send our data through the channel.
  // In sender-first case, value is buffered in the oneshot until receiver reads body_rx.
  // In receiver-first case, value goes directly to the waiting receiver.
  if body_tx.send(sender_data).is_err() {
    error!("Receiver disappeared: {}", id);
    manager.mark_session_expired(&id);
    return (StatusCode::INTERNAL_SERVER_ERROR, "Receiver disconnected\n").into_response();
  }

  // Wait for the receiver to finish streaming.
  sender_wait_completion(&manager, &id, completed_rx).await
}

async fn sender_wait_completion(manager: &TransferManager, id: &str, completed_rx: oneshot::Receiver<u64>) -> Response {
  let start = Instant::now();
  match tokio::time::timeout(MAX_WAIT_TIME, completed_rx).await {
    Ok(Ok(bytes)) => {
      let secs = start.elapsed().as_secs_f64();
      let speed = if secs > 0.001 {
        bytes as f64 / secs / 1024.0 / 1024.0
      } else {
        0.0
      };
      info!("Completed: {} | {} bytes | {:.2}s | {:.2} MB/s", id, bytes, secs, speed);
      manager.mark_session_completed(id);
      let msg = format!("Transfer completed: {} bytes ({:.2} MB/s)\n", bytes, speed);
      (StatusCode::OK, msg).into_response()
    }
    Ok(Err(_)) => {
      error!("Transfer failed (receiver dropped): {}", id);
      manager.mark_session_expired(id);
      (StatusCode::INTERNAL_SERVER_ERROR, "Transfer failed\n").into_response()
    }
    Err(_) => {
      error!("Timeout waiting for transfer: {}", id);
      manager.mark_session_expired(id);
      (StatusCode::REQUEST_TIMEOUT, "Transfer timeout\n").into_response()
    }
  }
}

async fn handle_receiver(Path(id): Path<String>, State(manager): State<TransferManager>) -> Response {
  if let Err(msg) = validate_transfer_id(&id) {
    return (StatusCode::BAD_REQUEST, msg).into_response();
  }

  if let Err((status, msg)) = manager.prepare_receiver_for_session(&id) {
    return (status, msg).into_response();
  }

  info!("Receiver connected: {}", id);

  enum Action {
    FromSender(oneshot::Receiver<SenderData>),
    WaitForSender(oneshot::Receiver<SenderData>),
  }

  let action = {
    let mut map = manager.transfers.lock();
    match map.get(&id) {
      Some(TransferSlot::ReceiverWaiting { .. }) => {
        error!("Transfer ID {} already has a receiver", id);
        return (StatusCode::CONFLICT, "Transfer ID already in use").into_response();
      }
      Some(TransferSlot::SenderWaiting { .. }) => {
        // Sender is waiting — take its body_rx.
        let slot = map.remove(&id).expect("entry exists");
        match slot {
          TransferSlot::SenderWaiting { body_rx, .. } => Action::FromSender(body_rx),
          _ => unreachable!(),
        }
      }
      None => {
        // No sender yet — we wait.
        let (body_tx, body_rx) = oneshot::channel();
        map.insert(id.clone(), TransferSlot::ReceiverWaiting {
          body_tx,
          created_at: Instant::now(),
        });
        Action::WaitForSender(body_rx)
      }
    }
  }; // lock released

  let sender_data = match action {
    Action::FromSender(body_rx) => {
      manager.mark_session_active(&id);
      // Sender already sent (or is about to send). Await briefly.
      match body_rx.await {
        Ok(data) => data,
        Err(_) => {
          error!("Sender disconnected: {}", id);
          manager.mark_session_expired(&id);
          return (StatusCode::INTERNAL_SERVER_ERROR, "Sender disconnected").into_response();
        }
      }
    }
    Action::WaitForSender(body_rx) => {
      let wait_timeout = manager.session_pairing_timeout(&id);
      match tokio::time::timeout(wait_timeout, body_rx).await {
        Ok(Ok(data)) => {
          info!("Sender matched for: {}", id);
          manager.mark_session_active(&id);
          data
        }
        Ok(Err(_)) => {
          error!("Sender channel closed: {}", id);
          manager.transfers.lock().remove(&id);
          manager.mark_session_expired(&id);
          return (StatusCode::INTERNAL_SERVER_ERROR, "Sender disconnected").into_response();
        }
        Err(_) => {
          error!("Timeout waiting for sender: {}", id);
          manager.transfers.lock().remove(&id);
          manager.mark_session_expired(&id);
          let status = if manager.has_active_or_completed_session(&id) {
            StatusCode::GONE
          } else {
            StatusCode::REQUEST_TIMEOUT
          };
          return (status, "Timeout waiting for sender").into_response();
        }
      }
    }
  };

  build_receiver_response(sender_data, &id, &manager)
}

fn build_receiver_response(data: SenderData, id: &str, manager: &TransferManager) -> Response {
  let SenderData {
    body,
    content_type,
    content_disposition,
    completed_tx,
  } = data;
  let id_owned = id.to_owned();

  let stream = async_stream::stream! {
      let mut total_bytes = 0u64;
      let mut body_stream = body.into_data_stream();

      while let Some(chunk_result) = body_stream.next().await {
          match chunk_result {
              Ok(chunk) => {
                  total_bytes += chunk.len() as u64;
                  yield Ok::<_, std::io::Error>(chunk);
              }
              Err(e) => {
                  error!("Stream error: {} - {}", id_owned, e);
                  break;
              }
          }
      }

      info!("Receiver done: {} | {} bytes transferred", id_owned, total_bytes);
      let _ = completed_tx.send(total_bytes);
  };

  let metadata = manager.get_metadata(id);

  let mut response_headers = HeaderMap::new();
  set_common_headers(&mut response_headers);

  let ct = content_type
    .or_else(|| {
      metadata
        .as_ref()
        .and_then(|m| m.mime_type.as_ref().and_then(|mime| HeaderValue::from_str(mime).ok()))
    })
    .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
  response_headers.insert(header::CONTENT_TYPE, ct);

  if let Some(disposition) = content_disposition.or_else(|| maybe_content_disposition_from_metadata(metadata)) {
    response_headers.insert(header::CONTENT_DISPOSITION, disposition);
  }

  let mut response = Response::new(Body::from_stream(stream));
  *response.status_mut() = StatusCode::OK;
  *response.headers_mut() = response_headers;
  response
}

async fn handle_status(State(manager): State<TransferManager>) -> impl IntoResponse {
  let (transfers, count) = {
    let map = manager.transfers.lock();
    let list: Vec<_> = map
      .iter()
      .map(|(id, slot)| {
        serde_json::json!({
            "id": id,
            "kind": slot.kind(),
            "age_secs": slot.created_at().elapsed().as_secs()
        })
      })
      .collect();
    let len = list.len();
    (list, len)
  };

  let session_count = manager.sessions.lock().len();

  axum::Json(serde_json::json!({
      "status": "healthy",
      "version": "3.1.0",
      "active_transfers": count,
      "active_sessions": session_count,
      "transfers": transfers,
      "architecture": "zero-copy lock-free streaming",
      "max_file_size": "unlimited",
      "transfer_timeout": "1 hour",
      "session_ttl": "10 minutes"
  }))
}

fn build_router(manager: TransferManager) -> Router {
  Router::new()
    .route("/status", get(handle_status))
    .route("/api/session", post(handle_create_session))
    .route("/api/session/{key}", get(handle_get_session))
    .route("/app", get(handle_app_index))
    .route("/app/{*path}", get(handle_app_path))
    .route("/assets/{*path}", get(handle_assets))
    .route("/{id}", put(handle_sender).get(handle_receiver))
    .with_state(manager)
}

fn listen_addr_from_env() -> String {
  let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
  let port = std::env::var("PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(8080);
  format!("{host}:{port}")
}

#[tokio::main]
async fn main() {
  let _ = tracing_subscriber::fmt()
    .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
    .try_init();

  let manager = TransferManager::new();
  manager.start_cleanup_task();

  let router = build_router(manager);
  let listen_addr = listen_addr_from_env();

  info!("Zero-Copy Piping Server v3.1.0");
  info!("Max file size: Unlimited");
  info!("Transfer timeout: 1 hour");
  info!("Session TTL: 10 minutes");
  info!("Listening on {}", listen_addr);

  let listener = match tokio::net::TcpListener::bind(&listen_addr).await {
    Ok(listener) => listener,
    Err(err) => {
      error!("Failed to bind {}: {}", listen_addr, err);
      std::process::exit(1);
    }
  };

  if let Err(err) = axum::serve(listener, router).await {
    error!("Server error: {}", err);
    std::process::exit(1);
  }
}

#[cfg(test)]
mod tests {
  use {
    super::*,
    axum::{
      body::Body,
      http::{
        Method,
        Request,
      },
    },
    http_body_util::BodyExt,
    tower::ServiceExt,
  };

  fn test_router() -> Router {
    let manager = TransferManager::new();
    build_router(manager)
  }

  #[test]
  fn test_transfer_id_validation() {
    assert!(validate_transfer_id("hello").is_ok());
    assert!(validate_transfer_id("a-b_c.d").is_ok());
    assert!(validate_transfer_id("abc123").is_ok());
    assert!(validate_transfer_id(&"a".repeat(128)).is_ok());

    assert!(validate_transfer_id("").is_err());
    assert!(validate_transfer_id(&"a".repeat(129)).is_err());
    assert!(validate_transfer_id("hello world").is_err());
    assert!(validate_transfer_id("../etc").is_err());
    assert!(validate_transfer_id("foo/bar").is_err());
  }

  #[test]
  fn test_session_key_validation() {
    assert!(validate_session_key("123456").is_ok());
    assert!(validate_session_key("000001").is_ok());
    assert!(validate_session_key("12345").is_err());
    assert!(validate_session_key("1234567").is_err());
    assert!(validate_session_key("12ab56").is_err());
  }

  #[tokio::test]
  async fn test_create_session_and_status() {
    let app = test_router();

    let req = Request::builder()
      .method(Method::POST)
      .uri("/api/session")
      .header("content-type", "application/json")
      .body(Body::from(r#"{"mode":"direct"}"#))
      .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let created: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let key = created["key"].as_str().unwrap();
    assert_eq!(key.len(), 6);
    assert!(key.chars().all(|c| c.is_ascii_digit()));

    let req = Request::builder()
      .method(Method::GET)
      .uri(format!("/api/session/{key}"))
      .body(Body::empty())
      .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
  }

  #[tokio::test]
  async fn test_sender_first_flow() {
    let app = test_router();

    let app_clone = app.clone();
    let sender_handle = tokio::spawn(async move {
      let req = Request::builder()
        .method(Method::PUT)
        .uri("/test-sender-first")
        .body(Body::from("hello world"))
        .unwrap();
      app_clone.oneshot(req).await.unwrap()
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let req = Request::builder()
      .method(Method::GET)
      .uri("/test-sender-first")
      .body(Body::empty())
      .unwrap();
    let receiver_resp = app.oneshot(req).await.unwrap();
    assert_eq!(receiver_resp.status(), StatusCode::OK);

    let body = receiver_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.as_ref(), b"hello world");

    let sender_resp = sender_handle.await.unwrap();
    assert_eq!(sender_resp.status(), StatusCode::OK);
  }

  #[tokio::test]
  async fn test_receiver_first_flow() {
    let app = test_router();

    // Receiver first (will block waiting for sender)
    let app_clone = app.clone();
    let receiver_handle = tokio::spawn(async move {
      let req = Request::builder()
        .method(Method::GET)
        .uri("/test-receiver-first")
        .body(Body::empty())
        .unwrap();
      app_clone.oneshot(req).await.unwrap()
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    // Sender must also be spawned — it waits for the stream to complete,
    // so we need to consume the receiver's response first to avoid deadlock.
    let sender_handle = tokio::spawn(async move {
      let req = Request::builder()
        .method(Method::PUT)
        .uri("/test-receiver-first")
        .body(Body::from("receiver was first"))
        .unwrap();
      app.oneshot(req).await.unwrap()
    });

    // Consume receiver response first (drives the stream to completion).
    let receiver_resp = receiver_handle.await.unwrap();
    assert_eq!(receiver_resp.status(), StatusCode::OK);

    let body = receiver_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.as_ref(), b"receiver was first");

    // Now sender can complete.
    let sender_resp = sender_handle.await.unwrap();
    assert_eq!(sender_resp.status(), StatusCode::OK);
  }

  #[tokio::test]
  async fn test_duplicate_sender_conflict() {
    let app = test_router();

    let app_clone = app.clone();
    let _sender1 = tokio::spawn(async move {
      let req = Request::builder()
        .method(Method::PUT)
        .uri("/dup-test")
        .body(Body::from("first"))
        .unwrap();
      app_clone.oneshot(req).await.unwrap()
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let req = Request::builder()
      .method(Method::PUT)
      .uri("/dup-test")
      .body(Body::from("second"))
      .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
  }

  #[tokio::test]
  async fn test_content_type_forwarding() {
    let app = test_router();

    let app_clone = app.clone();
    let _sender = tokio::spawn(async move {
      let req = Request::builder()
        .method(Method::PUT)
        .uri("/ct-test")
        .header("content-type", "text/plain; charset=utf-8")
        .body(Body::from("typed content"))
        .unwrap();
      app_clone.oneshot(req).await.unwrap()
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let req = Request::builder()
      .method(Method::GET)
      .uri("/ct-test")
      .body(Body::empty())
      .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("content-type").unwrap(), "text/plain; charset=utf-8");
  }

  #[tokio::test]
  async fn test_status_endpoint() {
    let app = test_router();

    let req = Request::builder()
      .method(Method::GET)
      .uri("/status")
      .body(Body::empty())
      .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "healthy");
    assert_eq!(json["version"], "3.1.0");
  }
}
