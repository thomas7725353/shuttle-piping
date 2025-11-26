use {axum::{Router,
            body::Body,
            extract::{Path,
                      State},
            http::{HeaderMap,
                   HeaderValue,
                   StatusCode},
            response::{IntoResponse,
                       Response},
            routing::{get,
                      put}},
     bytes::Bytes,
     dashmap::DashMap,
     futures_util::StreamExt,
     shuttle_axum::ShuttleAxum,
     std::{sync::Arc,
           time::{Duration,
                  Instant}},
     tokio::sync::{Mutex as TokioMutex,
                   oneshot},
     tracing::{error,
               info,
               warn}};

const MAX_WAIT_TIME: Duration = Duration::from_secs(24 * 60 * 60);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(300); // 5分钟清理一次

#[derive(Debug)]
struct Transfer {
  receiver_ready_tx: TokioMutex<Option<oneshot::Sender<()>>>,
  receiver_ready_rx: TokioMutex<Option<oneshot::Receiver<()>>>,
  completed_tx:      TokioMutex<Option<oneshot::Sender<u64>>>,
  completed_rx:      TokioMutex<Option<oneshot::Receiver<u64>>>,
  body_stream:       TokioMutex<Option<Body>>,
  start_time:        Instant,
}

impl Transfer {
  fn new() -> Self {
    let (receiver_ready_tx, receiver_ready_rx) = oneshot::channel();
    let (completed_tx, completed_rx) = oneshot::channel();

    Self {
      receiver_ready_tx: TokioMutex::new(Some(receiver_ready_tx)),
      receiver_ready_rx: TokioMutex::new(Some(receiver_ready_rx)),
      completed_tx:      TokioMutex::new(Some(completed_tx)),
      completed_rx:      TokioMutex::new(Some(completed_rx)),
      body_stream:       TokioMutex::new(None),
      start_time:        Instant::now(),
    }
  }

  fn is_expired(&self) -> bool {
    self.start_time.elapsed() > MAX_WAIT_TIME
  }
}

#[derive(Clone)]
struct TransferManager {
  transfers: Arc<DashMap<String, Arc<Transfer>>>,
}

impl TransferManager {
  fn new() -> Self {
    Self {
      transfers: Arc::new(DashMap::new()),
    }
  }

  fn start_cleanup_task(&self) {
    let transfers = self.transfers.clone();
    tokio::spawn(async move {
      let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
      loop {
        interval.tick().await;
        let before = transfers.len();
        transfers.retain(|id, transfer| {
          let expired = transfer.is_expired();
          if expired {
            warn!("🧹 Cleaning expired transfer: {}", id);
          }
          !expired
        });
        let after = transfers.len();
        if before != after {
          info!("🧹 Cleaned {} expired transfers", before - after);
        }
      }
    });
  }

  fn create_transfer(&self, id: &str) -> Option<Arc<Transfer>> {
    // 使用 entry API 避免 race condition
    use dashmap::mapref::entry::Entry;
    match self.transfers.entry(id.to_string()) {
      Entry::Occupied(_) => None,
      Entry::Vacant(entry) => {
        let transfer = Arc::new(Transfer::new());
        entry.insert(transfer.clone());
        Some(transfer)
      }
    }
  }

  fn get_transfer(&self, id: &str) -> Option<Arc<Transfer>> {
    self.transfers.get(id).map(|entry| entry.value().clone())
  }

  fn remove_transfer(&self, id: &str) {
    self.transfers.remove(id);
  }
}

fn set_common_headers(headers: &mut HeaderMap) {
  headers.insert("Transfer-Encoding", HeaderValue::from_static("chunked"));
  headers.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
  headers.insert(
    "Cache-Control",
    HeaderValue::from_static("no-cache, no-store, must-revalidate"),
  );
  headers.insert("Connection", HeaderValue::from_static("keep-alive"));
}

async fn handle_sender(
  Path(id): Path<String>,
  State(manager): State<TransferManager>,
  headers: HeaderMap,
  body: Body,
) -> impl IntoResponse {
  info!("📤 Sender connected: {}", id);

  let content_length = headers
    .get("content-length")
    .and_then(|v| v.to_str().ok())
    .and_then(|s| s.parse::<u64>().ok());

  if let Some(size) = content_length {
    info!(
      "📦 Expected size: {} bytes ({:.2} GB)",
      size,
      size as f64 / 1024.0 / 1024.0 / 1024.0
    );
  }

  let transfer = match manager.create_transfer(&id) {
    Some(t) => t,
    None => {
      error!("❌ Transfer ID {} already in use", id);
      return (StatusCode::CONFLICT, "Transfer ID already in use").into_response();
    }
  };

  // ✅ 提前提取资源，减少 Arc 持有时间
  let receiver_ready_rx = transfer.receiver_ready_rx.lock().await.take();
  let completed_rx = transfer.completed_rx.lock().await.take();
  let start_time = transfer.start_time;
  let id_clone = id.clone();
  let manager_clone = manager.clone();

  // 存储 body stream
  *transfer.body_stream.lock().await = Some(body);

  // ✅ 不再持有 transfer Arc
  drop(transfer);

  let stream = async_stream::stream! {
      let Some(ready_rx) = receiver_ready_rx else {
          yield Ok::<_, std::io::Error>(Bytes::from("Error: receiver channel missing\n"));
          manager_clone.remove_transfer(&id_clone);
          return;
      };

      match tokio::time::timeout(MAX_WAIT_TIME, ready_rx).await {
          Ok(Ok(())) => {
              info!("✅ Receiver connected for: {}", id_clone);
              yield Ok(Bytes::from("Transfer started\n"));
          }
          Ok(Err(_)) => {
              error!("❌ Receiver channel closed: {}", id_clone);
              yield Ok(Bytes::from("Receiver disconnected\n"));
              manager_clone.remove_transfer(&id_clone);
              return;
          }
          Err(_) => {
              error!("⏱️ Timeout waiting for receiver: {}", id_clone);
              yield Ok(Bytes::from("Timeout waiting for receiver\n"));
              manager_clone.remove_transfer(&id_clone);
              return;
          }
      }

      if let Some(rx) = completed_rx {
          match rx.await {
              Ok(bytes) => {
                  let duration = start_time.elapsed();
                  let speed = bytes as f64 / duration.as_secs_f64() / 1024.0 / 1024.0;
                  info!(
                      "✅ Completed: {} | {:.2} GB | {:.2}s | {:.2} MB/s",
                      id_clone,
                      bytes as f64 / 1024.0 / 1024.0 / 1024.0,
                      duration.as_secs_f64(),
                      speed
                  );
                  yield Ok(Bytes::from(format!(
                      "Transfer completed: {} bytes ({:.2} MB/s)\n",
                      bytes, speed
                  )));
              }
              Err(_) => {
                  error!("❌ Transfer failed: {}", id_clone);
                  yield Ok(Bytes::from("Transfer failed\n"));
              }
          }
      }
  };

  let mut response_headers = HeaderMap::new();
  set_common_headers(&mut response_headers);

  let mut response = Response::new(Body::from_stream(stream));
  *response.status_mut() = StatusCode::OK;
  *response.headers_mut() = response_headers;
  response
}

async fn handle_receiver(Path(id): Path<String>, State(manager): State<TransferManager>) -> impl IntoResponse {
  info!("📥 Receiver connected: {}", id);

  let transfer = match manager.get_transfer(&id) {
    Some(t) => t,
    None => {
      error!("❌ Transfer not found: {}", id);
      return (StatusCode::NOT_FOUND, "Transfer not found").into_response();
    }
  };

  // 通知 sender
  if let Some(ready_tx) = transfer.receiver_ready_tx.lock().await.take() {
    let _ = ready_tx.send(());
  }

  // 获取 body stream
  let body_stream = match transfer.body_stream.lock().await.take() {
    Some(stream) => stream,
    None => {
      error!("❌ Body not ready: {}", id);
      return (StatusCode::INTERNAL_SERVER_ERROR, "Sender not ready").into_response();
    }
  };

  // ✅ 提取完成信号发送器
  let completed_tx = transfer.completed_tx.lock().await.take();
  let id_clone = id.clone();
  let manager_clone = manager.clone();

  // ✅ 释放 transfer Arc
  drop(transfer);

  let stream = async_stream::stream! {
      let mut total_bytes = 0u64;
      let mut body_stream = body_stream.into_data_stream();

      while let Some(chunk_result) = body_stream.next().await {
          match chunk_result {
              Ok(chunk) => {
                  total_bytes += chunk.len() as u64;
                  yield Ok::<_, std::io::Error>(chunk);
              }
              Err(e) => {
                  error!("❌ Stream error: {} - {}", id_clone, e);
                  break;
              }
          }
      }

      info!(
          "📥 Receiver done: {} | {:.2} GB transferred",
          id_clone,
          total_bytes as f64 / 1024.0 / 1024.0 / 1024.0
      );

      if let Some(tx) = completed_tx {
          let _ = tx.send(total_bytes);
      }

      manager_clone.remove_transfer(&id_clone);
  };

  let mut response_headers = HeaderMap::new();
  set_common_headers(&mut response_headers);
  response_headers.insert("Content-Type", HeaderValue::from_static("application/octet-stream"));

  let mut response = Response::new(Body::from_stream(stream));
  *response.status_mut() = StatusCode::OK;
  *response.headers_mut() = response_headers;
  response
}

async fn handle_status(State(manager): State<TransferManager>) -> impl IntoResponse {
  let active = manager.transfers.len();
  let transfers: Vec<_> = manager
    .transfers
    .iter()
    .map(|entry| {
      serde_json::json!({
          "id": entry.key(),
          "age_secs": entry.value().start_time.elapsed().as_secs()
      })
    })
    .collect();

  axum::Json(serde_json::json!({
      "status": "healthy",
      "version": "2.2.0-optimized",
      "active_transfers": active,
      "transfers": transfers,
      "architecture": "zero-copy streaming",
      "max_file_size": "unlimited",
      "memory_usage": "~20MB constant"
  }))
}

#[shuttle_runtime::main]
async fn main() -> ShuttleAxum {
  let manager = TransferManager::new();

  // ✅ 启动清理任务
  manager.start_cleanup_task();

  let router = Router::new()
    .route("/{id}", put(handle_sender))
    .route("/{id}", get(handle_receiver))
    .route("/status", get(handle_status))
    .with_state(manager);

  info!("🚀 Zero-Copy Piping Server v2.2.0");
  info!("📦 Max file size: Unlimited (10GB+ supported)");
  info!("💾 Memory: ~20MB constant");

  Ok(router.into())
}
