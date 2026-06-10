#!/bin/bash

echo "=== Shuttle Piping 测试示例 ==="
SERVER_URL="${SERVER_URL:-http://127.0.0.1:8787}"
echo "服务地址: $SERVER_URL"
echo ""

# 示例1：简单文本
echo "示例1: 简单文本传输"
echo "在另一个终端运行: curl $SERVER_URL/demo1"
echo "然后在这里按回车发送数据..."
read -p "准备好了吗? [Enter继续] "
echo "Hello from Piping!" | curl -T - "$SERVER_URL/demo1"
echo ""

# 示例2：文件传输
echo "示例2: 创建并传输一个测试文件"
echo "测试内容" > /tmp/test_file.txt
echo "Test content 2" >> /tmp/test_file.txt
echo "文件已创建: /tmp/test_file.txt"
echo "在另一个终端运行: curl $SERVER_URL/demo2 > received.txt"
read -p "准备好了吗? [Enter继续] "
curl -T /tmp/test_file.txt "$SERVER_URL/demo2"
echo ""

# 示例3：管道传输
echo "示例3: 压缩文件传输"
echo "在另一个终端运行: curl $SERVER_URL/demo3 | tar -xzf -"
read -p "准备好了吗? [Enter继续] "
tar -czf - /tmp/test_file.txt | curl -T - "$SERVER_URL/demo3"
echo ""

echo "=== 测试完成 ==="
