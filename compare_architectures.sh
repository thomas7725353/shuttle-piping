#!/bin/bash

# 架构对比测试脚本
# 比较 Channel-Based vs Zero-Copy 架构的性能

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   架构对比测试工具                                      ║${NC}"
echo -e "${BLUE}║   Channel-Based vs Zero-Copy                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# 检查是否有两个版本的代码
if [ ! -f "src/main.rs" ]; then
    echo -e "${RED}错误: src/main.rs 不存在${NC}"
    exit 1
fi

if [ ! -f "src/main_zero_copy.rs" ]; then
    echo -e "${RED}错误: src/main_zero_copy.rs 不存在${NC}"
    exit 1
fi

echo -e "${CYAN}当前架构:${NC}"
if grep -q "CHANNEL_BUFFER_SIZE" src/main.rs 2>/dev/null; then
    echo "  📦 Channel-Based (缓冲架构)"
    CURRENT_ARCH="buffered"
elif grep -q "SYNC_BUFFER_SIZE" src/main.rs 2>/dev/null; then
    echo "  ⚡ Zero-Copy (零拷贝架构)"
    CURRENT_ARCH="zero-copy"
else
    echo -e "${YELLOW}  ⚠️  无法识别当前架构${NC}"
    CURRENT_ARCH="unknown"
fi
echo ""

# 询问测试文件大小
read -p "$(echo -e ${YELLOW}输入测试文件大小 \(MB\): ${NC})" FILE_SIZE

if ! [[ "$FILE_SIZE" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}错误: 请输入有效的数字${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  测试配置: ${FILE_SIZE} MB 文件${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# 创建测试文件
TEST_FILE="/tmp/test_${FILE_SIZE}mb.bin"
if [ ! -f "$TEST_FILE" ]; then
    echo -e "${YELLOW}创建测试文件...${NC}"
    dd if=/dev/urandom of="$TEST_FILE" bs=1M count=$FILE_SIZE 2>&1 | grep -v "records"
    echo -e "${GREEN}✓ 测试文件创建完成${NC}"
else
    echo -e "${GREEN}✓ 使用现有测试文件${NC}"
fi
echo ""

# 理论分析
echo -e "${CYAN}📊 理论分析:${NC}"
echo "────────────────────────────────────────────────────────"

# Channel-Based 架构
CHANNEL_BUFFER_MB=64
BUFFERED_OVERHEAD=$((50 + CHANNEL_BUFFER_MB + 10))
BUFFERED_TOTAL=$((BUFFERED_OVERHEAD))

echo -e "${YELLOW}Channel-Based 架构:${NC}"
echo "  • Sender buffer: ~50 MB"
echo "  • Channel buffer: ~${CHANNEL_BUFFER_MB} MB (1024 chunks)"
echo "  • Receiver buffer: ~10 MB"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  • 预计内存: ~${BUFFERED_TOTAL} MB (固定)"
if [ "$FILE_SIZE" -gt 300 ]; then
    echo -e "  • 状态: ${RED}⚠️  接近内存限制${NC}"
else
    echo "  • 状态: ✅ 安全"
fi
echo ""

# Zero-Copy 架构
ZEROCOPY_BASE=15
ZEROCOPY_OVERHEAD=5
ZEROCOPY_TOTAL=$((ZEROCOPY_BASE + ZEROCOPY_OVERHEAD))

echo -e "${YELLOW}Zero-Copy 架构:${NC}"
echo "  • Sender buffer: ~2-5 MB (仅当前块)"
echo "  • Sync channel: ~0.0001 MB"
echo "  • Receiver buffer: ~2-5 MB (仅当前块)"
echo "  • 应用开销: ~5 MB"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  • 预计内存: ~${ZEROCOPY_TOTAL} MB (与文件大小无关!)"
echo "  • 状态: ✅ 完美"
echo ""

# 内存节省
MEMORY_SAVED=$((BUFFERED_TOTAL - ZEROCOPY_TOTAL))
MEMORY_SAVED_PCT=$((MEMORY_SAVED * 100 / BUFFERED_TOTAL))

echo -e "${GREEN}💡 内存节省:${NC}"
echo "  • 节省: ${MEMORY_SAVED} MB (${MEMORY_SAVED_PCT}%)"
echo "  • 提升: ${BUFFERED_TOTAL}MB → ${ZEROCOPY_TOTAL}MB"
echo "────────────────────────────────────────────────────────"
echo ""

# 性能预测
echo -e "${CYAN}⚡ 性能预测:${NC}"
echo "────────────────────────────────────────────────────────"

# 假设网速 1 MB/s
NETWORK_SPEED=1
TRANSFER_TIME=$((FILE_SIZE / NETWORK_SPEED))

# Channel-Based 有额外开销
BUFFERED_OVERHEAD_PCT=10
BUFFERED_TIME=$((TRANSFER_TIME * (100 + BUFFERED_OVERHEAD_PCT) / 100))

# Zero-Copy 无开销
ZEROCOPY_TIME=$TRANSFER_TIME

TIME_SAVED=$((BUFFERED_TIME - ZEROCOPY_TIME))

echo -e "${YELLOW}传输时间 (假设 ${NETWORK_SPEED} MB/s):${NC}"
echo "  • Channel-Based: ~${BUFFERED_TIME}s (有 ${BUFFERED_OVERHEAD_PCT}% 开销)"
echo "  • Zero-Copy: ~${ZEROCOPY_TIME}s (无开销)"
echo "  • 节省: ${TIME_SAVED}s (${BUFFERED_OVERHEAD_PCT}%)"
echo ""

echo -e "${YELLOW}吞吐量:${NC}"
BUFFERED_THROUGHPUT=$((FILE_SIZE * 1000 / BUFFERED_TIME))
ZEROCOPY_THROUGHPUT=$((FILE_SIZE * 1000 / ZEROCOPY_TIME))
echo "  • Channel-Based: ~${BUFFERED_THROUGHPUT} KB/s"
echo "  • Zero-Copy: ~${ZEROCOPY_THROUGHPUT} KB/s"
echo "  • 提升: $((ZEROCOPY_THROUGHPUT * 100 / BUFFERED_THROUGHPUT - 100))%"
echo "────────────────────────────────────────────────────────"
echo ""

# 推荐架构
echo -e "${GREEN}🎯 推荐架构:${NC}"
echo "────────────────────────────────────────────────────────"

if [ "$FILE_SIZE" -le 100 ]; then
    echo "  文件大小: ${FILE_SIZE} MB (小文件)"
    echo "  推荐: ${YELLOW}Channel-Based${NC}"
    echo "  理由:"
    echo "    • 内存开销可接受"
    echo "    • 可以实时统计进度"
    echo "    • 更好的错误处理"
    RECOMMENDED="buffered"
elif [ "$FILE_SIZE" -le 500 ]; then
    echo "  文件大小: ${FILE_SIZE} MB (中等文件)"
    echo "  推荐: ${CYAN}两者皆可${NC}"
    echo "  理由:"
    echo "    • Channel-Based: 稳定可靠"
    echo "    • Zero-Copy: 更少内存,更快速度"
    RECOMMENDED="both"
else
    echo "  文件大小: ${FILE_SIZE} MB (大文件)"
    echo "  推荐: ${GREEN}Zero-Copy${NC} ⭐⭐⭐⭐⭐"
    echo "  理由:"
    echo "    • 显著减少内存占用 (${MEMORY_SAVED_PCT}%)"
    echo "    • 更快的传输速度"
    echo "    • 支持更大文件 (> 1 GB)"
    RECOMMENDED="zero-copy"
fi
echo "────────────────────────────────────────────────────────"
echo ""

# 切换架构提示
if [ "$RECOMMENDED" != "buffered" ] && [ "$RECOMMENDED" != "both" ]; then
    if [ "$CURRENT_ARCH" != "zero-copy" ]; then
        echo -e "${YELLOW}💡 建议切换到 Zero-Copy 架构:${NC}"
        echo ""
        echo "  1. 备份当前版本:"
        echo "     ${BLUE}cp src/main.rs src/main_buffered.rs${NC}"
        echo ""
        echo "  2. 切换到 Zero-Copy:"
        echo "     ${BLUE}cp src/main_zero_copy.rs src/main.rs${NC}"
        echo ""
        echo "  3. 重新部署:"
        echo "     ${BLUE}cargo check${NC}"
        echo "     ${BLUE}cargo shuttle deploy${NC}"
        echo ""
    else
        echo -e "${GREEN}✓ 当前已使用推荐的 Zero-Copy 架构${NC}"
    fi
fi

# 实际测试选项
echo ""
read -p "$(echo -e ${YELLOW}是否运行实际传输测试? \(y/N\): ${NC})" RUN_TEST

if [[ "$RUN_TEST" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${CYAN}运行传输测试...${NC}"

    # 检查服务器是否运行
    if ! pgrep -f "shuttle-piping" > /dev/null && ! pgrep -f "cargo run" > /dev/null; then
        echo -e "${RED}错误: 服务器未运行${NC}"
        echo "请先运行: cargo shuttle run"
        exit 1
    fi

    # 执行测试
    ./test_transfer.sh "$TEST_FILE"
else
    echo ""
    echo -e "${BLUE}跳过实际测试${NC}"
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ 分析完成!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# 快速参考
echo -e "${YELLOW}📚 快速参考:${NC}"
echo ""
echo "  • 查看详细文档: ${BLUE}cat ZERO_COPY_ARCHITECTURE.md${NC}"
echo "  • 容量分析: ${BLUE}cat CAPACITY.md${NC}"
echo "  • 调优工具: ${BLUE}./tune_capacity.sh${NC}"
echo ""

# 清理
if [[ "$RUN_TEST" =~ ^[Yy]$ ]]; then
    read -p "$(echo -e ${YELLOW}删除测试文件? \(y/N\): ${NC})" CLEANUP
    if [[ "$CLEANUP" =~ ^[Yy]$ ]]; then
        rm -f "$TEST_FILE"
        echo -e "${GREEN}✓ 测试文件已删除${NC}"
    fi
fi
