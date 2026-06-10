# Shuttle Piping

面向小文件和文本的 HTTP 流式传输服务。本分支改为 Cloudflare Worker + Durable Object 后端，前端继续使用现有 React/Vite UI。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 特性

- **纯 TypeScript Worker 后端** — 使用 Cloudflare Workers 和 Durable Objects
- **直接 HTTP 流式传输** — 不落对象存储，发送端数据直接流向接收端
- **发送端/接收端先到都支持** — 任一方可以先等待
- **保留浏览器 UI** — 现有 React/Vite 前端通过 Worker 静态资源托管
- **6 位 key、链接和二维码** — UI session 默认 10 分钟过期
- **兼容 curl 用法** — 保留原版 `piping-server` 风格的 `PUT /path` 到 `GET /path`

## Cloudflare 限制

这个 Worker 版本适合文本和小文件。上传请求体大小受 Cloudflare 账号套餐限制：

- Free / Pro: 100 MB
- Business: 200 MB
- Enterprise: 默认 500 MB，可联系 Cloudflare 调整

响应可以流式返回，但超过账号上传上限的请求会在进入 Worker 前被 Cloudflare 拒绝。若需要原版 `piping-server` 那种无限大文件、超长时间 HTTP 流，请继续使用容器或 VM 后端。

## 快速开始

设置部署后的 Worker 地址：

```bash
export SERVER_URL="https://shuttle-piping.<your-subdomain>.workers.dev"
```

终端 1：

```bash
echo "Hello, Piping!" | curl -T - "$SERVER_URL/my-transfer"
```

终端 2：

```bash
curl "$SERVER_URL/my-transfer"
```

任一终端可先连接，服务会自动配对。

### 文件传输

```bash
# 发送
curl -T ./myfile.txt "$SERVER_URL/file-transfer"

# 接收
curl "$SERVER_URL/file-transfer" > received.txt
```

### 压缩传输

```bash
# 发送
tar -czf - ./my-directory | curl -T - "$SERVER_URL/backup"

# 接收
curl "$SERVER_URL/backup" | tar -xzf -
```

## 本地开发

前置要求：

- Node.js 22+
- npm
- Cloudflare Wrangler CLI，或直接使用本项目的 `npx wrangler`

安装依赖：

```bash
npm install
npm --prefix web install
```

本地运行：

```bash
npm run build:web
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

打开：

```bash
http://127.0.0.1:8787/app
```

## 部署

登录 Cloudflare：

```bash
npx wrangler login
```

部署前校验：

```bash
npm run cf:dry-run
```

部署：

```bash
npm run deploy
```

`wrangler.toml` 配置了：

- `web/dist` 静态资源
- `TRANSFER_OBJECT` Durable Object 绑定
- 初始 Durable Object migration

## API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/{id}` | `PUT` / `POST` | 发送数据 |
| `/{id}` | `GET` | 接收数据 |
| `/api/session` | `POST` | 创建 6 位 UI session |
| `/api/session/{key}` | `GET` | 查询 session 状态 |
| `/status` | `GET` | 健康检查和后端信息 |

原版 `piping-server` 的 `?n=` 多接收端模式在 Worker 后端暂不支持。当前版本每个 path 支持一个发送端和一个接收端。

## 项目结构

```
shuttle-piping/
├── worker/src/index.ts      # Cloudflare Worker 和 Durable Object 后端
├── web/                     # React/Vite 前端
├── wrangler.toml            # Cloudflare Worker 配置
├── package.json             # Worker 构建/部署脚本
├── test_examples.sh         # 手动测试示例
├── test_transfer.sh         # 文件传输 smoke test
└── LICENSE
```

## 旧 Rust 后端

之前的 Rust/Axum 后端仍保留在 `src/main.rs`，方便迁移期间参考。本分支的主部署目标已经改为 Cloudflare Worker。

## 致谢

- [piping-server](https://github.com/nwtgck/piping-server) — 原版 HTTP 流式传输行为
- [Cloudflare Workers](https://workers.cloudflare.com/) — Worker 运行时
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) — 每个传输 key 的会合协调
