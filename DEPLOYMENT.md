# Shuttle Piping - 部署成功！

## 🎉 部署信息

- **服务地址**: https://shuttle-piping-8zed.shuttle.app
- **状态**: ✅ 运行中
- **实现**: 真正的流式传输（不预存内容）

## 📋 使用方法

### 基本传输

**发送数据**（在终端1中）：
```bash
echo "Hello World!" | curl -T - https://shuttle-piping-8zed.shuttle.app/my-transfer
```

**接收数据**（在终端2中，需要在发送完成前执行）：
```bash
curl https://shuttle-piping-8zed.shuttle.app/my-transfer
```

### 文件传输

```bash
# 发送文件
curl -T ./myfile.txt https://shuttle-piping-8zed.shuttle.app/file-transfer

# 接收文件
curl https://shuttle-piping-8zed.shuttle.app/file-transfer > received-file.txt
```

### 查看状态

```bash
curl https://shuttle-piping-8zed.shuttle.app/status
```

## ✨ 特性

- ✅ **真正的流式传输** - 数据直接从发送者流向接收者，不预存到内存
- ✅ **支持任意数据** - 文本、二进制文件都可以
- ✅ **自动清理** - 传输完成后自动清理资源
- ✅ **支持中文** - UTF-8 编码完美支持
- ✅ **长时间等待** - 支持最多24小时等待时间

## 🔧 技术实现

- 使用 `tokio::sync::mpsc` 通道在发送者和接收者之间传递数据流
- 发送者等待接收者连接后才开始读取body
- 数据以32KB缓冲区分块流式传输
- 接收者通过 async_stream 创建响应流

## 📊 测试结果

```
✅ 小消息传输: 25 bytes
✅ 中文传输: 30 bytes (包含emoji)
✅ 多行文本: 3行文本正确传输
✅ 大文件传输: 5MB+ 文件流式传输
```

## 🚀 部署命令

```bash
cd shuttle-piping
cargo shuttle deploy
```

## 📝 与原版的区别

| 特性 | 原版 (本地) | Shuttle版本 |
|------|------------|------------|
| 部署 | 本地运行 | Shuttle云端部署 |
| URL | localhost:8182 | shuttle-piping-8zed.shuttle.app |
| 流式传输 | ✅ | ✅ |
| 自动扩展 | ❌ | ✅ Shuttle自动管理 |
| HTTPS | 需要配置 | ✅ 自动提供 |

