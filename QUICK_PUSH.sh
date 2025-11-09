#!/bin/bash

echo "=========================================="
echo "  快速推送到 GitHub"
echo "=========================================="
echo ""
echo "请先在浏览器中完成以下操作："
echo ""
echo "1. 访问: https://github.com/new"
echo "2. 仓库名: shuttle-piping"
echo "3. 设为 Public"
echo "4. 不要添加 README/LICENSE/.gitignore"
echo "5. 点击 'Create repository'"
echo ""
echo "----------------------------------------"
echo ""
read -p "已创建仓库? 请输入您的 GitHub 用户名: " username

if [ -z "$username" ]; then
    echo "❌ 用户名不能为空"
    exit 1
fi

echo ""
echo "正在配置并推送..."
echo ""

# 添加 remote
git remote add origin "https://github.com/$username/shuttle-piping.git" 2>/dev/null || \
    git remote set-url origin "https://github.com/$username/shuttle-piping.git"

# 确保在 main 分支
git branch -M main

# 推送
echo "推送到 https://github.com/$username/shuttle-piping.git ..."
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "  ✅ 成功!"
    echo "=========================================="
    echo ""
    echo "您的仓库: https://github.com/$username/shuttle-piping"
    echo ""
else
    echo ""
    echo "=========================================="
    echo "  ⚠️  需要认证"
    echo "=========================================="
    echo ""
    echo "GitHub 现在需要使用 Personal Access Token"
    echo ""
    echo "请按照以下步骤:"
    echo "1. 访问: https://github.com/settings/tokens"
    echo "2. 生成新 token (勾选 'repo' 权限)"
    echo "3. 再次运行此脚本"
    echo "4. 推送时用户名输入: $username"
    echo "5. 密码输入: 粘贴刚才的 token"
    echo ""
fi
