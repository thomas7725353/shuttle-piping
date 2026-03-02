# Shuttle Piping — HTTP 流式传输服务

[![Rust](https://img.shields.io/badge/Rust-1.70%2B-orange.svg)](https://www.rust-lang.org/)
[![Shuttle](https://img.shields.io/badge/Shuttle-v0.57-blue.svg)](https://www.shuttle.rs/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

基于 Rust + Axum + Shuttle 的高性能零拷贝流式传输服务，支持任意大小文件的实时点对点传输。

## 特性

- **零拷贝流式传输** — 数据直接从发送端流向接收端，无内存缓存
- **无限文件大小** — 支持 10GB+ 传输，内存恒定 ~20MB
- **双向先到支持** — 发送端或接收端谁先连接都可以
- **Content-Type 透传** — 发送端的 Content-Type 自动传递给接收端
- **传输 ID 校验** — 仅允许 `[a-zA-Z0-9._-]`，最长 128 字符
- **自动清理** — 过期传输 1 小时后自动清理
- **云端部署** — 一键部署到 Shuttle，自动 HTTPS

---

## 在线服务

**生产环境**: https://shuttle-piping-8zed.shuttle.app

```bash
curl https://shuttle-piping-8zed.shuttle.app/status
```

---

## 快速开始

### 基本使用

**终端 1 — 发送数据**:
```bash
echo "Hello, Piping!" | curl -T - https://shuttle-piping-8zed.shuttle.app/my-transfer
```

**终端 2 — 接收数据**:
```bash
curl https://shuttle-piping-8zed.shuttle.app/my-transfer
```

任一终端可先连接，服务会自动配对。

### 文件传输

```bash
# 发送
curl -T ./myfile.txt https://shuttle-piping-8zed.shuttle.app/file-transfer

# 接收
curl https://shuttle-piping-8zed.shuttle.app/file-transfer > received.txt
```

### 压缩传输

```bash
# 发送 (压缩)
tar -czf - ./my-directory | curl -T - https://shuttle-piping-8zed.shuttle.app/backup

# 接收 (解压)
curl https://shuttle-piping-8zed.shuttle.app/backup | tar -xzf -
```

### 并发传输

```bash
# 使用不同的传输 ID
curl -T file1.bin https://your-url/transfer1 &
curl -T file2.bin https://your-url/transfer2 &
wait
```

---

## 架构 (v3.0.0)

```
Sender (PUT /{id})              Receiver (GET /{id})
       │                               │
       ▼                               ▼
┌─────────────────────────────────────────────┐
│           TransferManager                   │
│  parking_lot::Mutex<HashMap<String, Slot>>  │
│                                             │
│  SenderWaiting ←→ ReceiverWaiting           │
│  (oneshot channel 会合点)                    │
└─────────────────────────────────────────────┘
       │                               │
       └───── 零拷贝 Body 流 ──────────┘
```

### 核心设计

- **零 Mutex/Transfer** — 仅一个 `parking_lot::Mutex` 保护协调 Map，持锁时间微秒级
- **Oneshot 会合** — 先到方插入槽位，后到方取出并通过 oneshot channel 交换 Body
- **无竞态条件** — Body 所有权原子转移

---

## 本地开发

### 前置要求

- Rust 1.70+
- Shuttle CLI: `cargo install cargo-shuttle`

### 本地运行

```bash
git clone https://github.com/your-repo/shuttle-piping.git
cd shuttle-piping
cargo shuttle run
# http://localhost:8000
```

### 部署

```bash
cargo shuttle login
cargo shuttle deploy
```

### 测试

```bash
cargo test
```

---

## 项目结构

```
shuttle-piping/
├── src/main.rs              # 服务器 (处理器、传输管理器、测试)
├── Cargo.toml               # 依赖配置
├── README.md                # 英文文档
├── README_CN.md             # 中文文档
├── DEPLOYMENT_GUIDE.md      # 部署指南
├── ZERO_COPY_ARCHITECTURE.md # 架构深度解析
├── test_examples.sh         # 测试示例脚本
├── test_transfer.sh         # 传输测试脚本
└── LICENSE                  # MIT 许可证
```

---

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/{id}` | PUT | 发送数据 |
| `/{id}` | GET | 接收数据 |
| `/status` | GET | 服务健康状态和活跃传输 |

---

## 版本历史

### v3.0.0

- 全新无锁架构：oneshot channel 会合 + parking_lot Mutex
- 消除全部竞态条件
- 支持 Receiver 先连接
- Content-Type 透传
- 传输 ID 校验
- 过期时间缩短为 1 小时
- 删除 hop-by-hop 非法头
- 添加单元测试

### v2.2.0

- 零拷贝架构 + DashMap

### v1.0.0

- 基础文件流式传输功能

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)

## 致谢

- [Shuttle.rs](https://www.shuttle.rs/) — Rust 云平台
- [Axum](https://github.com/tokio-rs/axum) — Web 框架
- [Tokio](https://tokio.rs/) — 异步运行时
