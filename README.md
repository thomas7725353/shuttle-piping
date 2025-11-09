# Shuttle Piping

基于 [Shuttle](https://github.com/shuttle-hq/shuttle) 部署的 Piping HTTP 流传输服务。这是一个允许通过 PUT 上传数据、GET 下载数据的内存级传输服务。

## 特性

- 🚀 基于 Shuttle 一键部署到云端
- 💾 内存传输，无需磁盘存储
- 🔄 流式传输，支持大文件
- ⏱️ 自动清理完成的传输
- 🔍 内置状态监控
- 🛡️ 防止并发冲突

## 快速开始

### 1. 安装 Shuttle

```bash
# 安装 Shuttle CLI
cargo install shuttle-deploy

# 登录 Shuttle 账户
shuttle login
```

### 2. 本地开发

```bash
# 进入项目目录
cd shuttle-piping

# 本地运行测试
cargo run

# 启动测试服务器
cargo shuttle run
```

### 3. 部署到 Shuttle

```bash
# 部署到 Shuttle
cargo shuttle deploy

# 查看部署状态
cargo shuttle status

# 查看日志
cargo shuttle logs
```

## API 使用

### 基本传输

**发送文件:**
```bash
curl -T ./large-file.txt https://your-app-name.shuttleapp.rs/my-transfer-id
```

**接收文件:**
```bash
curl -o received-file.txt https://your-app-name.shuttleapp.rs/my-transfer-id
```

### 状态监控

```bash
curl https://your-app-name.shuttleapp.rs/status
```

响应示例:
```json
{
  "active_transfers": 2,
  "version": "1.0.0",
  "status": "healthy"
}
```

### 高级用法

#### 流式传输

```bash
# 发送命令输出
curl -T <(tail -f /var/log/syslog) https://your-app-name.shuttleapp.rs/log-stream

# 接收并保存
curl https://your-app-name.shuttleapp.rs/log-stream > syslog-output.log
```

#### 并行传输

```bash
# 并发发送多个文件
curl -T file1.txt https://your-app-name.shuttleapp.rs/transfer-1 &
curl -T file2.txt https://your-app-name.shuttleapp.rs/transfer-2 &
curl -T file3.txt https://your-app-name.shuttleapp.rs/transfer-3 &

# 并发接收
curl -o received1.txt https://your-app-name.shuttleapp.rs/transfer-1 &
curl -o received2.txt https://your-app-name.shuttleapp.rs/transfer-2 &
curl -o received3.txt https://your-app-name.shuttleapp.rs/transfer-3 &
```

#### 管道操作

```bash
# 压缩并传输
tar -czf - ./my-directory | curl -T - https://your-app-name.shuttleapp.rs/dir-backup

# 接收并解压
curl https://your-app-name.shuttleapp.rs/dir-backup | tar -xzf -
```

## 项目结构

```
shuttle-piping/
├── Cargo.toml          # 项目依赖配置
├── README.md           # 项目说明
└── src/
    └── main.rs         # 主程序代码
```

## 本地测试

### 1. 启动本地服务

```bash
cd shuttle-piping
cargo run
```

服务将在 `http://localhost:3000` 启动 (Shuttle 默认端口)

### 2. 测试传输功能

```bash
# 在一个终端发送数据
echo "Hello, Shuttle Piping!" | curl -T - http://localhost:3000/test-transfer

# 在另一个终端接收数据
curl http://localhost:3000/test-transfer
```

### 3. 查看服务状态

```bash
curl http://localhost:3000/status
```

## 部署配置

 Shuttle 会自动处理以下配置：
- **端口管理**: 自动分配和管理端口
- **环境变量**: 支持自定义环境变量
- **健康检查**: 自动健康检查
- **日志记录**: 结构化日志记录

## 环境变量

可以通过 `Cargo.toml` 或 Shuttle 控制台设置环境变量：

```toml
# Cargo.toml
[dependencies]
# ... 其他依赖

[env]
RUST_LOG = "debug"
```

## 故障排除

### 常见问题

1. **部署失败**: 检查 Shuttle 登录状态和账户权限
2. **依赖错误**: 确保所有依赖在 `Cargo.toml` 中正确定义
3. **端口冲突**: Shuttle 会自动处理端口分配

### 调试技巧

```bash
# 查看详细日志
RUST_LOG=debug cargo shuttle run

# 查看部署历史
cargo shuttle history

# 回滚部署
cargo shuttle rollback <deployment-id>
```

## 与原始版本对比

| 特性 | Shuttle Piping | 原生 Piping |
|------|---------------|-------------|
| 部署方式 | Shuttle 云端部署 | 本地部署 |
| 默认端口 | 3000 | 8182 |
| 配置管理 | 自动配置 | 手动配置 |
| 扩展性 | 自动扩展 | 依赖服务器配置 |
| 监控 | Shuttle 内置监控 | 需要额外监控 |

## 许可证

本项目采用 MIT 许可证。