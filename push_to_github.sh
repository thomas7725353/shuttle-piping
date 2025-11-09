#!/bin/bash

echo "================================================"
echo "  Shuttle Piping - GitHub 推送向导"
echo "================================================"
echo ""

# 检查是否已经有 remote
if git remote get-url origin 2>/dev/null; then
    echo "✅ 已配置 Git remote:"
    git remote -v
    echo ""
    read -p "是否要推送到现有仓库? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "正在推送..."
        git push -u origin main
        exit 0
    fi
fi

echo "需要创建 GitHub 仓库。请按照以下步骤操作："
echo ""
echo "方法 1: 使用 GitHub CLI (推荐)"
echo "------------------------"
echo "1. 如果还没安装 gh，运行: brew install gh"
echo "2. 登录 GitHub: gh auth login"
echo "3. 创建仓库: gh repo create shuttle-piping --public --source=. --remote=origin"
echo "4. 推送代码: git push -u origin main"
echo ""
echo "方法 2: 手动创建 (如果 gh 不可用)"
echo "------------------------"
echo "1. 访问: https://github.com/new"
echo "2. 仓库名称: shuttle-piping"
echo "3. 描述: HTTP streaming service deployed on Shuttle"
echo "4. 选择 Public"
echo "5. 不要初始化 README (我们已经有了)"
echo "6. 创建后，GitHub 会显示推送命令，类似于:"
echo ""
echo "   git remote add origin https://github.com/YOUR_USERNAME/shuttle-piping.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo ""
echo "================================================"
echo ""

read -p "您想要使用哪种方法? (1/2/取消): " choice

case $choice in
    1)
        echo ""
        echo "尝试使用 GitHub CLI..."
        if ! command -v gh &> /dev/null; then
            echo "❌ gh 未安装。请运行: brew install gh"
            exit 1
        fi
        
        echo "检查 gh 登录状态..."
        if ! gh auth status 2>/dev/null; then
            echo "需要登录 GitHub..."
            gh auth login
        fi
        
        echo "创建仓库..."
        gh repo create shuttle-piping --public --source=. --remote=origin --description="HTTP streaming service deployed on Shuttle - Zero-storage real-time data transfer"
        
        echo "推送代码..."
        git push -u origin main
        
        echo ""
        echo "✅ 完成！您的仓库地址："
        gh repo view --web
        ;;
    2)
        echo ""
        echo "请在浏览器中访问: https://github.com/new"
        echo "创建仓库后，请输入您的 GitHub 用户名："
        read -p "GitHub 用户名: " username
        
        if [ -z "$username" ]; then
            echo "❌ 用户名不能为空"
            exit 1
        fi
        
        echo ""
        echo "正在配置 remote..."
        git remote add origin "https://github.com/$username/shuttle-piping.git"
        git branch -M main
        
        echo "正在推送..."
        git push -u origin main
        
        echo ""
        echo "✅ 完成！您的仓库地址："
        echo "https://github.com/$username/shuttle-piping"
        ;;
    *)
        echo "取消操作"
        exit 0
        ;;
esac

echo ""
echo "================================================"
echo "  🎉 成功推送到 GitHub!"
echo "================================================"
