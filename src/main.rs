use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
    Router, body::Body,
};
use futures::StreamExt;
use http_body_util::BodyExt;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    time,
};
use tracing::{error, info};
use shuttle_axum::ShuttleAxum;
use bytes::Bytes;

const MAX_WAIT_TIME: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug)]
struct Transfer {
    // Sender waits on this to get the data channel from receiver
    receiver_ready_tx: Mutex<Option<oneshot::Sender<mpsc::Sender<Result<Bytes, String>>>>>,
    receiver_ready_rx: Mutex<Option<oneshot::Receiver<mpsc::Sender<Result<Bytes, String>>>>>,
    start_time: Instant,
}

impl Transfer {
    fn new() -> Self {
        let (receiver_ready_tx, receiver_ready_rx) = oneshot::channel();

        Self {
            receiver_ready_tx: Mutex::new(Some(receiver_ready_tx)),
            receiver_ready_rx: Mutex::new(Some(receiver_ready_rx)),
            start_time: Instant::now(),
        }
    }
}

#[derive(Clone)]
struct TransferManager {
    transfers: Arc<Mutex<HashMap<String, Arc<Transfer>>>>,
}

impl TransferManager {
    fn new() -> Self {
        Self {
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn create_transfer(&self, id: &str) -> Option<Arc<Transfer>> {
        let mut transfers = self.transfers.lock().await;
        if transfers.contains_key(id) {
            None
        } else {
            let transfer = Arc::new(Transfer::new());
            transfers.insert(id.to_string(), transfer.clone());
            Some(transfer)
        }
    }

    async fn get_transfer(&self, id: &str) -> Option<Arc<Transfer>> {
        let transfers = self.transfers.lock().await;
        transfers.get(id).cloned()
    }

    async fn remove_transfer(&self, id: &str) {
        let mut transfers = self.transfers.lock().await;
        transfers.remove(id);
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
    body: Body,
) -> impl IntoResponse {
    info!("New sender connected for transfer ID: {}", id);

    let transfer = match manager.create_transfer(&id).await {
        Some(t) => t,
        None => {
            return (StatusCode::CONFLICT, "Transfer ID already in use").into_response();
        }
    };

    let mut headers = HeaderMap::new();
    set_common_headers(&mut headers);

    // Take receiver_ready_rx to wait for receiver
    let receiver_ready_rx = transfer.receiver_ready_rx.lock().await.take().unwrap();

    // Wait for receiver to connect and get the data channel
    let data_tx = match time::timeout(MAX_WAIT_TIME, receiver_ready_rx).await {
        Ok(Ok(tx)) => {
            info!("Receiver connected for transfer ID: {}", id);
            tx
        }
        Ok(Err(_)) => {
            error!("Receiver channel closed: {}", id);
            manager.remove_transfer(&id).await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Receiver channel closed").into_response();
        }
        Err(_) => {
            error!("Timeout waiting for receiver: {}", id);
            manager.remove_transfer(&id).await;
            return (StatusCode::REQUEST_TIMEOUT, "Timeout waiting for receiver").into_response();
        }
    };

    // Stream the body to the receiver through the data channel
    let mut body_stream = body.into_data_stream();
    let mut total_bytes = 0u64;
    
    while let Some(chunk_result) = body_stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                total_bytes += chunk.len() as u64;
                if data_tx.send(Ok(chunk)).await.is_err() {
                    error!("Receiver disconnected for transfer ID: {}", id);
                    break;
                }
            }
            Err(e) => {
                error!("Error reading body for transfer ID {}: {}", id, e);
                let _ = data_tx.send(Err(format!("Error: {}", e))).await;
                break;
            }
        }
    }
    
    drop(data_tx); // Close the channel to signal end of stream
    manager.remove_transfer(&id).await;
    
    info!("Transfer completed for ID: {}, bytes: {}", id, total_bytes);
    
    let mut response = Response::new(Body::from(format!("Transfer completed: {} bytes\n", total_bytes)));
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = headers;
    response
}

async fn handle_receiver(
    Path(id): Path<String>,
    State(manager): State<TransferManager>,
) -> impl IntoResponse {
    info!("New receiver connected for transfer ID: {}", id);

    let transfer = match manager.get_transfer(&id).await {
        Some(t) => t,
        None => {
            return (StatusCode::NOT_FOUND, "Transfer not found").into_response();
        }
    };

    let mut headers = HeaderMap::new();
    set_common_headers(&mut headers);
    headers.insert(
        "Content-Type",
        HeaderValue::from_static("application/octet-stream"),
    );

    // Create a channel for receiving data from sender
    let (data_tx, mut data_rx) = mpsc::channel::<Result<Bytes, String>>(32);
    
    // Notify sender that receiver is ready and give it the data channel
    if let Some(ready_tx) = transfer.receiver_ready_tx.lock().await.take() {
        if ready_tx.send(data_tx).is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to notify sender").into_response();
        }
    } else {
        return (StatusCode::CONFLICT, "Receiver already connected").into_response();
    }

    // Create a stream that reads from the channel
    let stream = async_stream::stream! {
        while let Some(result) = data_rx.recv().await {
            match result {
                Ok(chunk) => {
                    yield Ok::<_, String>(chunk);
                }
                Err(e) => {
                    error!("Stream error: {}", e);
                    break;
                }
            }
        }
    };

    let body = Body::from_stream(stream);
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    *response.headers_mut() = headers;
    response
}

async fn handle_status(State(manager): State<TransferManager>) -> impl IntoResponse {
    let transfers = manager.transfers.lock().await;
    axum::Json(serde_json::json!({
        "active_transfers": transfers.len(),
        "version": "1.0.0",
        "status": "healthy"
    }))
}

#[shuttle_runtime::main]
async fn main() -> ShuttleAxum {
    let manager = TransferManager::new();

    let router = Router::new()
        .route("/{id}", put(handle_sender))
        .route("/{id}", get(handle_receiver))
        .route("/status", get(handle_status))
        .with_state(manager);

    Ok(router.into())
}
