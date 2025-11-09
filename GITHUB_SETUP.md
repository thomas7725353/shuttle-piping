# 推送到 GitHub 指南

## 🚀 快速推送（推荐）

### 选项 1: 使用提供的脚本

```bash
cd /Users/andy/RustroverProjects/piping/shuttle-piping
./push_to_github.sh
```

### 选项 2: 手动步骤

#### Step 1: 在 GitHub 上创建仓库

1. 访问 https://github.com/new
2. 填写信息：
   - **仓库名**: `shuttle-piping`
   - **描述**: `HTTP streaming service deployed on Shuttle - Zero-storage real-time data transfer`
   - **可见性**: Public
   - ⚠️ **不要**勾选 "Add a README file"
   - ⚠️ **不要**勾选 "Add .gitignore"
   - ⚠️ **不要**勾选 "Choose a license"

3. 点击 "Create repository"

#### Step 2: 推送本地代码

GitHub 会显示推送命令，复制并执行（替换 YOUR_USERNAME）：

```bash
cd /Users/andy/RustroverProjects/piping/shuttle-piping

# 添加 remote (替换 YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/shuttle-piping.git

# 重命名分支为 main
git branch -M main

# 推送代码
git push -u origin main
```

## 📝 当前状态

本地仓库已准备就绪：
- ✅ Git 仓库已初始化
- ✅ 所有文件已提交（2 commits）
- ✅ README.md 已完善
- ✅ LICENSE 已添加
- ✅ .gitignore 已配置

```bash
# 查看当前提交历史
git log --oneline

# 查看文件列表
git ls-files
```

## 🔧 如果遇到问题

### 问题 1: 推送被拒绝

如果看到错误：
```
! [rejected] main -> main (fetch first)
```

解决方案：
```bash
git pull origin main --rebase
git push -u origin main
```

### 问题 2: 认证失败

如果使用 HTTPS 推送需要认证，GitHub 现在要求使用 Personal Access Token：

1. 访问 https://github.com/settings/tokens
2. 点击 "Generate new token (classic)"
3. 勾选 `repo` 权限
4. 生成并复制 token
5. 推送时使用 token 作为密码

或者切换到 SSH：
```bash
# 移除 HTTPS remote
git remote remove origin

# 添加 SSH remote (替换 YOUR_USERNAME)
git remote add origin git@github.com:YOUR_USERNAME/shuttle-piping.git

# 推送
git push -u origin main
```

## 🎯 推送后的下一步

1. 访问仓库主页
2. 查看 README 渲染效果
3. 添加 Topics (建议):
   - `rust`
   - `shuttle`
   - `http-streaming`
   - `piping`
   - `axum`
   - `tokio`

4. 启用 GitHub Pages（可选）
5. 添加徽章到 README（可选）

## 📞 需要帮助？

如果遇到任何问题，请查看：
- GitHub 文档: https://docs.github.com/en/get-started/importing-your-projects-to-github/importing-source-code-to-github/adding-locally-hosted-code-to-github
- 或在项目中创建 Issue

---

准备好后，只需执行：
```bash
./push_to_github.sh
```
