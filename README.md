# Shuttle Piping

HTTP streaming transfer service deployed on [Shuttle](https://shuttle.dev) — true zero-storage streaming.

[![Deploy on Shuttle](https://img.shields.io/badge/Deploy%20on-Shuttle-orange)](https://shuttle.dev)
[![Rust](https://img.shields.io/badge/Rust-1.70+-orange.svg)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **Zero-copy streaming** — data flows directly from sender to receiver, no buffering
- **Unlimited file size** — supports 10GB+ transfers with constant ~20MB memory
- **Receiver-first support** — either side can connect first
- **Content-Type forwarding** — sender's Content-Type is passed to receiver
- **Transfer ID validation** — safe IDs only: `[a-zA-Z0-9._-]`, max 128 chars
- **Auto cleanup** — expired transfers cleaned up after 1 hour
- **Cloud-ready** — one-command deploy to Shuttle with automatic HTTPS

## Live Service

**Production**: https://shuttle-piping-8zed.shuttle.app

```bash
curl https://shuttle-piping-8zed.shuttle.app/status
```

## Quick Start

**Terminal 1 — Send**:
```bash
echo "Hello, Piping!" | curl -T - https://shuttle-piping-8zed.shuttle.app/my-transfer
```

**Terminal 2 — Receive**:
```bash
curl https://shuttle-piping-8zed.shuttle.app/my-transfer
```

Either terminal can connect first — the service pairs them automatically.

### File Transfer

```bash
# Send
curl -T ./myfile.txt https://shuttle-piping-8zed.shuttle.app/file-transfer

# Receive
curl https://shuttle-piping-8zed.shuttle.app/file-transfer > received.txt
```

### Compressed Transfer

```bash
# Send (compress)
tar -czf - ./my-directory | curl -T - https://shuttle-piping-8zed.shuttle.app/backup

# Receive (decompress)
curl https://shuttle-piping-8zed.shuttle.app/backup | tar -xzf -
```

### Real-time Log Streaming

```bash
# Send
tail -f /var/log/syslog | curl -T - https://shuttle-piping-8zed.shuttle.app/logs

# Receive
curl https://shuttle-piping-8zed.shuttle.app/logs
```

## Architecture (v3.0.0)

```
Sender (PUT /{id})              Receiver (GET /{id})
       │                               │
       ▼                               ▼
┌─────────────────────────────────────────────┐
│           TransferManager                   │
│  parking_lot::Mutex<HashMap<String, Slot>>  │
│                                             │
│  SenderWaiting ←→ ReceiverWaiting           │
│  (oneshot channel rendezvous)               │
└─────────────────────────────────────────────┘
       │                               │
       └───── zero-copy Body stream ───┘
```

- **Zero Mutex per transfer** — single `parking_lot::Mutex` on the coordination map, held only for microsecond insert/remove
- **Oneshot rendezvous** — first party inserts a slot, second party takes it and they exchange the Body through a oneshot channel
- **No race conditions** — body ownership is transferred atomically

## Local Development

### Prerequisites

- Rust 1.70+
- Shuttle CLI: `cargo install cargo-shuttle`

### Run Locally

```bash
git clone https://github.com/YOUR_USERNAME/shuttle-piping.git
cd shuttle-piping
cargo shuttle run
# http://localhost:8000
```

### Deploy

```bash
cargo shuttle login
cargo shuttle deploy
```

### Test

```bash
cargo test
```

## GitOps (Minikube + Argo CD)

This repository includes an Argo CD application and Kubernetes manifests for local GitOps testing:

- Argo CD app manifest: `deploy/argocd/application.yaml`
- Kubernetes manifests: `deploy/k8s/`
- Container build file: `Dockerfile`
- Automation workflow: `.github/workflows/gitops-image-update.yml`

### End-to-end Auto Deploy Flow

1. Push code to `main`.
2. GitHub Actions builds and pushes image to GHCR: `ghcr.io/thomas7725353/shuttle-piping:sha-<commit_sha>`.
3. The same workflow updates `deploy/k8s/deployment.yaml` image tag and commits it back to `main`.
4. Argo CD detects manifest changes in `deploy/k8s` and auto-syncs to cluster.
5. Kubernetes rolls out the new image automatically.

### Bootstrap (first time only)

1. Apply Argo CD app once:
```bash
kubectl apply -f deploy/argocd/application.yaml
```
2. Ensure GHCR package `shuttle-piping` is readable by your cluster runtime (public image recommended for local testing).

### Important Note About Commits

Argo CD reacts to Git commits, but it only changes Kubernetes resources when files under the tracked manifest path (`deploy/k8s`) actually change.

- Commit only `README.md`: workflow still builds image, but Argo CD rollout depends on whether `deploy/k8s` changed.
- Commit changes in `deploy/k8s`: Argo CD will auto-sync and rollout updates.

## Project Structure

```
shuttle-piping/
├── Dockerfile               # Container build for local K8s deployment
├── deploy/
│   ├── argocd/application.yaml # Argo CD Application
│   └── k8s/                # K8s manifests for GitOps sync
├── src/main.rs              # Server (handlers, transfer manager, tests)
├── Cargo.toml               # Dependencies
├── README.md                # English documentation
├── README_CN.md             # Chinese documentation
├── DEPLOYMENT_GUIDE.md      # Deployment guide
├── ZERO_COPY_ARCHITECTURE.md # Architecture deep-dive
├── test_examples.sh         # Example test scripts
├── test_transfer.sh         # Transfer test script
└── LICENSE                  # MIT License
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/{id}` | PUT | Send data (sender) |
| `/{id}` | GET | Receive data (receiver) |
| `/status` | GET | Service health and active transfers |

## License

MIT — see [LICENSE](LICENSE)

## Acknowledgments

- [Shuttle](https://shuttle.dev) — Rust cloud platform
- [Axum](https://github.com/tokio-rs/axum) — Web framework
- [Tokio](https://tokio.rs) — Async runtime
