#!/bin/bash

# 架构切换脚本
# 在 Channel-Based 和 Zero-Copy 之间切换

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   架构切换工具                                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# 检测当前架构
detect_current_arch() {
    if [ ! -f "src/main.rs" ]; then
        echo "unknown"
        return
    fi

    if grep -q "const CHANNEL_BUFFER_SIZE" src/main.rs 2>/dev/null; then
        echo "buffered"
    elif grep -q "const SYNC_BUFFER_SIZE" src/main.rs 2>/dev/null; then
        echo "zero-copy"
    else
        echo "unknown"
    fi
}

CURRENT_ARCH=$(detect_current_arch)

echo -e "${CYAN}当前架构:${NC}"
case $CURRENT_ARCH in
    "buffered")
        echo "  📦 Channel-Based (缓冲架构)"
        echo "  • 内存使用: ~64-200 MB"
        echo "  • 支持文件: < 300 MB"
        echo "  • 特点: 可统计进度,稳定可靠"
        ;;
    "zero-copy")
        echo "  ⚡ Zero-Copy (零拷贝架构)"
        echo "  • 内存使用: ~10-25 MB"
        echo "  • 支持文件: < 10 TB"
        echo "  • 特点: 极低内存,超高性能"
        ;;
    *)
        echo -e "  ${RED}⚠️  无法识别架构${NC}"
        ;;
esac
echo ""

# 显示可用架构
echo -e "${YELLOW}可用架构:${NC}"
echo ""

echo "1. 📦 Channel-Based (缓冲架构)"
echo "   • 适合: < 300 MB 文件"
echo "   • 优点: 实时进度统计,稳定可靠"
echo "   • 缺点: 内存占用较大 (~64 MB 固定)"
echo ""

echo "2. ⚡ Zero-Copy (零拷贝架构)"
echo "   • 适合: > 500 MB 文件, 1GB RAM 限制"
echo "   • 优点: 极低内存 (~20 MB),理论无限大文件"
echo "   • 缺点: 无法实时统计进度"
echo ""

# 选择架构
read -p "$(echo -e ${YELLOW}选择目标架构 \(1/2\) 或按 Enter 取消: ${NC})" CHOICE

case $CHOICE in
    1)
        TARGET_ARCH="buffered"
        TARGET_NAME="Channel-Based"
        SOURCE_FILE="src/main_buffered.rs"
        ;;
    2)
        TARGET_ARCH="zero-copy"
        TARGET_NAME="Zero-Copy"
        SOURCE_FILE="src/main_zero_copy.rs"
        ;;
    "")
        echo ""
        echo -e "${BLUE}取消切换${NC}"
        exit 0
        ;;
    *)
        echo ""
        echo -e "${RED}无效选择${NC}"
        exit 1
        ;;
esac

# 检查是否需要切换
if [ "$CURRENT_ARCH" = "$TARGET_ARCH" ]; then
    echo ""
    echo -e "${GREEN}✓ 当前已使用 $TARGET_NAME 架构,无需切换${NC}"
    exit 0
fi

echo ""
echo -e "${YELLOW}切换到 $TARGET_NAME 架构...${NC}"
echo ""

# 检查源文件是否存在
if [ "$TARGET_ARCH" = "buffered" ] && [ ! -f "$SOURCE_FILE" ]; then
    echo -e "${RED}错误: $SOURCE_FILE 不存在${NC}"
    echo "请确保备份文件存在"
    exit 1
fi

if [ "$TARGET_ARCH" = "zero-copy" ] && [ ! -f "src/main_zero_copy.rs" ]; then
    echo -e "${RED}错误: src/main_zero_copy.rs 不存在${NC}"
    exit 1
fi

# 备份当前版本
BACKUP_FILE="src/main_$(date +%Y%m%d_%H%M%S).rs"
echo "1. 备份当前版本..."
cp src/main.rs "$BACKUP_FILE"
echo -e "   ${GREEN}✓ 已备份到: $BACKUP_FILE${NC}"
echo ""

# 切换架构
echo "2. 切换架构..."
if [ "$TARGET_ARCH" = "buffered" ]; then
    cp "$SOURCE_FILE" src/main.rs
elif [ "$TARGET_ARCH" = "zero-copy" ]; then
    cp src/main_zero_copy.rs src/main.rs
fi
echo -e "   ${GREEN}✓ 已切换到 $TARGET_NAME 架构${NC}"
echo ""

# 验证编译
echo "3. 验证代码..."
if cargo check 2>&1 | grep -q "error"; then
    echo -e "   ${RED}✗ 编译失败${NC}"
    echo ""
    echo "恢复原始版本..."
    cp "$BACKUP_FILE" src/main.rs
    rm "$BACKUP_FILE"
    echo -e "${RED}切换失败,已恢复原版本${NC}"
    exit 1
else
    echo -e "   ${GREEN}✓ 编译成功${NC}"
fi
echo ""

# 显示差异
echo -e "${CYAN}📊 架构差异:${NC}"
echo "────────────────────────────────────────────────────────"

if [ "$TARGET_ARCH" = "zero-copy" ]; then
    echo -e "${YELLOW}切换前 (Channel-Based):${NC}"
    echo "  • 内存使用: ~64-200 MB"
    echo "  • 支持文件: < 300 MB"
    echo "  • Channel 缓冲: 1024 chunks (64 MB)"
    echo ""
    echo -e "${GREEN}切换后 (Zero-Copy):${NC}"
    echo "  • 内存使用: ~10-25 MB (节省 85%+)"
    echo "  • 支持文件: < 10 TB (33,000x 提升!)"
    echo "  • Sync channel: ~100 bytes (99.9% 减少)"
else
    echo -e "${YELLOW}切换前 (Zero-Copy):${NC}"
    echo "  • 内存使用: ~10-25 MB"
    echo "  • 支持文件: < 10 TB"
    echo "  • 无进度统计"
    echo ""
    echo -e "${GREEN}切换后 (Channel-Based):${NC}"
    echo "  • 内存使用: ~64-200 MB"
    echo "  • 支持文件: < 300 MB"
    echo "  • 可实时统计进度"
fi
echo "────────────────────────────────────────────────────────"
echo ""

echo -e "${GREEN}✅ 切换完成!${NC}"
echo ""

# 下一步
echo -e "${YELLOW}📋 下一步操作:${NC}"
echo ""
echo "1. 本地测试:"
echo "   ${BLUE}cargo shuttle run${NC}"
echo ""
echo "2. 部署到生产:"
echo "   ${BLUE}cargo shuttle deploy${NC}"
echo ""
echo "3. 验证新架构:"
echo "   ${BLUE}./test_transfer.sh /path/to/testfile${NC}"
echo ""

# 性能建议
if [ "$TARGET_ARCH" = "zero-copy" ]; then
    echo -e "${CYAN}💡 零拷贝架构建议:${NC}"
    echo "  • 适合大文件传输 (> 500 MB)"
    echo "  • 内存占用恒定,不随文件大小增长"
    echo "  • 可以传输 10 GB+ 文件 (1GB RAM)"
    echo "  • 测试: ./compare_architectures.sh"
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
