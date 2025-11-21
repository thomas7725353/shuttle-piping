#!/bin/bash

# Shuttle Piping 容量调优脚本
# 根据目标文件大小自动推荐配置

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Shuttle Piping 容量调优助手                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# 询问目标文件大小
read -p "$(echo -e ${YELLOW}请输入目标文件大小 \(MB\): ${NC})" TARGET_SIZE

# 验证输入
if ! [[ "$TARGET_SIZE" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}错误: 请输入有效的数字${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  分析目标: ${TARGET_SIZE} MB 文件传输${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# 计算推荐配置
if [ "$TARGET_SIZE" -le 100 ]; then
    BUFFER_SIZE=1024
    RATING="⭐⭐⭐⭐⭐"
    STATUS="${GREEN}完全稳定${NC}"
    SUCCESS_RATE="99%+"
    MEMORY="~120MB"
    SHUTTLE_PLAN="免费版"
    ACTION="✅ 使用当前配置，无需修改"
elif [ "$TARGET_SIZE" -le 300 ]; then
    BUFFER_SIZE=1024
    RATING="⭐⭐⭐⭐"
    STATUS="${GREEN}稳定${NC}"
    SUCCESS_RATE="95%+"
    MEMORY="~180MB"
    SHUTTLE_PLAN="免费版"
    ACTION="✅ 当前配置已优化，建议测试后部署"
elif [ "$TARGET_SIZE" -le 500 ]; then
    BUFFER_SIZE=2048
    RATING="⭐⭐⭐"
    STATUS="${YELLOW}可行但有风险${NC}"
    SUCCESS_RATE="80%+"
    MEMORY="~220MB"
    SHUTTLE_PLAN="免费版 (接近上限)"
    ACTION="⚠️ 建议增加 CHANNEL_BUFFER_SIZE 到 2048"
elif [ "$TARGET_SIZE" -le 1000 ]; then
    BUFFER_SIZE=4096
    RATING="⭐⭐"
    STATUS="${YELLOW}需要 Pro 版${NC}"
    SUCCESS_RATE="70%"
    MEMORY="~400MB"
    SHUTTLE_PLAN="Pro 版 (推荐)"
    ACTION="💰 建议升级到 Shuttle Pro 版"
else
    BUFFER_SIZE=8192
    RATING="⭐"
    STATUS="${RED}不推荐/需要重新设计${NC}"
    SUCCESS_RATE="< 50%"
    MEMORY="~600MB+"
    SHUTTLE_PLAN="Pro 版 + 架构重新设计"
    ACTION="❌ 建议实现分块上传或使用专业文件传输服务"
fi

# 显示分析结果
echo -e "${GREEN}📊 容量分析结果:${NC}"
echo "────────────────────────────────────────────────────────"
echo -e "  文件大小:         ${YELLOW}${TARGET_SIZE} MB${NC}"
echo -e "  推荐缓冲:         ${BLUE}${BUFFER_SIZE} chunks (~$((BUFFER_SIZE * 64 / 1024)) MB)${NC}"
echo -e "  内存峰值:         ${BLUE}${MEMORY}${NC}"
echo -e "  传输状态:         ${STATUS}"
echo -e "  成功率:           ${BLUE}${SUCCESS_RATE}${NC}"
echo -e "  推荐评级:         ${RATING}"
echo -e "  Shuttle 版本:     ${BLUE}${SHUTTLE_PLAN}${NC}"
echo "────────────────────────────────────────────────────────"
echo ""

echo -e "${YELLOW}🔧 推荐操作:${NC}"
echo "  ${ACTION}"
echo ""

# 如果需要修改配置
if [ "$BUFFER_SIZE" -ne 1024 ]; then
    echo -e "${YELLOW}📝 配置修改步骤:${NC}"
    echo ""
    echo "1. 编辑 src/main.rs:"
    echo "   找到第 24 行:"
    echo "   ${RED}const CHANNEL_BUFFER_SIZE: usize = 1024;${NC}"
    echo ""
    echo "   修改为:"
    echo "   ${GREEN}const CHANNEL_BUFFER_SIZE: usize = ${BUFFER_SIZE};${NC}"
    echo ""
    echo "2. 重新编译和部署:"
    echo "   ${BLUE}cargo check${NC}"
    echo "   ${BLUE}cargo shuttle deploy${NC}"
    echo ""
fi

# 性能预估
CHUNKS=$((TARGET_SIZE * 1024 / 64))
BUFFER_UTIL=$((CHUNKS * 100 / BUFFER_SIZE))
TRANSFER_TIME=$((TARGET_SIZE / 1))  # 假设 1 MB/s

echo -e "${BLUE}📈 性能预估:${NC}"
echo "────────────────────────────────────────────────────────"
echo "  预计 Chunks:      ~${CHUNKS}"
echo "  缓冲利用率:       ~${BUFFER_UTIL}%"
echo "  传输时间 (1MB/s): ~${TRANSFER_TIME}s ($(echo "scale=1; $TRANSFER_TIME/60" | bc 2>/dev/null || echo "N/A")分钟)"
echo "────────────────────────────────────────────────────────"
echo ""

# 风险警告
if [ "$TARGET_SIZE" -gt 300 ]; then
    echo -e "${RED}⚠️  风险警告:${NC}"
    if [ "$TARGET_SIZE" -gt 1000 ]; then
        echo "  • 文件过大,成功率 < 50%"
        echo "  • 强烈建议实现分块上传"
        echo "  • 或使用专业文件传输服务 (AWS S3, Google Cloud Storage)"
    elif [ "$TARGET_SIZE" -gt 500 ]; then
        echo "  • 免费版内存可能不足"
        echo "  • 建议升级到 Shuttle Pro 版 (2GB RAM)"
        echo "  • 或压缩文件后传输"
    else
        echo "  • 接近免费版内存上限"
        echo "  • 建议充分测试后部署"
        echo "  • 监控内存使用: cargo shuttle logs"
    fi
    echo ""
fi

# 测试建议
echo -e "${GREEN}🧪 测试建议:${NC}"
echo ""
echo "1. 创建测试文件:"
echo "   ${BLUE}dd if=/dev/urandom of=/tmp/test_${TARGET_SIZE}mb.bin bs=1M count=${TARGET_SIZE}${NC}"
echo ""
echo "2. 运行传输测试:"
echo "   ${BLUE}./test_transfer.sh /tmp/test_${TARGET_SIZE}mb.bin${NC}"
echo ""
echo "3. 监控服务器日志:"
echo "   ${BLUE}cargo shuttle logs --follow${NC}"
echo ""

# 压缩建议
if [ "$TARGET_SIZE" -gt 200 ]; then
    echo -e "${YELLOW}💡 优化建议:${NC}"
    echo ""
    echo "  考虑使用压缩传输:"
    echo "  ${BLUE}gzip -c file.bin | curl -T - https://your-url/transfer${NC}"
    echo "  ${BLUE}curl https://your-url/transfer | gunzip > file.bin${NC}"
    echo ""
    COMPRESSED_SIZE=$((TARGET_SIZE * 60 / 100))  # 假设 40% 压缩率
    echo "  预估压缩后大小: ~${COMPRESSED_SIZE}MB (节省 ~$((TARGET_SIZE - COMPRESSED_SIZE))MB)"
    echo ""
fi

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ 分析完成!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# 快速参考
echo -e "${YELLOW}📚 快速参考:${NC}"
echo ""
echo "  • 查看完整文档: ${BLUE}cat CAPACITY.md${NC}"
echo "  • 部署指南:     ${BLUE}cat DEPLOYMENT_GUIDE.md${NC}"
echo "  • 运行测试:     ${BLUE}./test_transfer.sh <file>${NC}"
echo ""
