# Swil Flow

**Swil Flow** 是一个基于 [Handy](https://github.com/cjpais/Handy) 二次开发的桌面语音转文字应用，当前以 macOS 为主要开发和分发目标。

它保留了 Handy 的本地离线转写能力与 Tauri 架构，同时将品牌、开发流程和后续产品化方向调整为 **Supwilsoft** 自有版本。

## 项目定位

- 基于 Handy 的下游 fork / 二次开发版本
- 当前以 macOS 桌面端为主，不以移动端为目标
- 保持本地离线语音转文字能力
- 适合作为个人或小范围分发的桌面应用基础

## 上游关系

- 上游项目：`Handy`
- 上游仓库：`https://github.com/cjpais/Handy`
- 当前 fork 目标：在保留核心架构的前提下，逐步演进为 `Swil Flow`

本仓库仍然遵循原始项目的 MIT 许可证。二次开发时请保留原许可声明。

## 当前品牌配置

- 生产版 App 名称：`Swil Flow`
- 生产版 Bundle Identifier：`com.supwilsoft.swilflow`
- 开发版 App 名称：`Swil Flow Dev`
- 开发版 Bundle Identifier：`com.supwilsoft.swilflow.dev`
- 品牌主体：`Supwilsoft`

说明：

- Tauri 打包后的应用名称已经切换为 `Swil Flow`
- 当前 Cargo 包名和原始底层二进制名仍保留上游的 `handy`
- 因此在某些低层构建输出里，仍可能看到 `handy` 这个名字，这属于当前过渡状态

## 技术栈

- 桌面壳：Tauri 2
- 前端：React + TypeScript + Vite
- 后端：Rust
- 语音模型：Whisper / Parakeet
- 音频处理：`cpal`、`rubato`、`vad-rs`
- 本地数据库：SQLite

## 主要功能

- 全局快捷键触发录音
- 本地离线语音转文字
- 模型下载与管理
- 录音历史与转写历史
- 托盘菜单
- 粘贴到当前输入框
- 可选的后处理能力

## 开发环境要求

### 通用

- [Rust](https://rustup.rs/)
- [Bun](https://bun.sh/)
- `cmake`

### macOS

- Xcode Command Line Tools
- 如果你只装了 Command Line Tools，没有完整 Xcode，也可以开发
- 当前仓库已在构建脚本中处理 Apple Intelligence 回退：没有完整 Xcode 时会自动使用 stub，不再阻塞开发构建

推荐检查：

```bash
rustc --version
cargo --version
bun --version
cmake --version
xcode-select -p
```

如果缺 Bun 或 CMake，可以用 Homebrew：

```bash
brew install oven-sh/bun/bun
brew install cmake
```

## 本地开发

### 1. 安装依赖

```bash
bun install
```

### 2. 可选：先做 Rust 检查

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

### 3. 启动开发版 App

请优先使用开发版配置，而不是直接跑默认的 Tauri dev：

```bash
bun run app:dev
```

这个命令会使用：

- `Swil Flow Dev`
- `com.supwilsoft.swilflow.dev`

从而避免和生产版 App 标识混用。

### 4. 仅启动前端

```bash
bun run dev
```

## 生产构建

```bash
bun run app:build
```

说明：

- 目前自动更新已默认禁用
- 当前不会生成 updater artifacts
- 后续如果要做正式分发，需要接入你自己的签名和更新源

## 推荐的开发版 / 生产版隔离方式

除了使用独立的开发版 Bundle Identifier，当前仓库还支持 **portable mode**。

### 启用 portable mode

```bash
mkdir -p src-tauri/target/debug/Data
printf "Handy Portable Mode\n" > src-tauri/target/debug/portable
```

然后再运行：

```bash
bun run app:dev
```

### portable mode 的作用

启用后，开发版的数据会写到：

```bash
src-tauri/target/debug/Data
```

其中通常会包含：

- `settings_store.json`
- `history.db`
- `recordings/`
- 模型和日志目录

这样做可以避免污染你机器上已经安装的正式版数据。

## 默认数据目录

### 生产版

- macOS: `~/Library/Application Support/com.supwilsoft.swilflow/`

### 开发版

- 如果使用 portable mode：`src-tauri/target/debug/Data/`
- 如果不使用 portable mode：由开发版 identifier 决定的系统应用数据目录

## Apple Intelligence 说明

当前 fork 对 Apple Intelligence 的策略是：

- 如果系统 SDK 和完整 Xcode toolchain 可用，则按原能力编译
- 如果只有 Command Line Tools，构建脚本会自动退回 stub
- 如需强制禁用，可使用：

```bash
SWILFLOW_DISABLE_APPLE_INTELLIGENCE=1 cargo check --manifest-path src-tauri/Cargo.toml
SWILFLOW_DISABLE_APPLE_INTELLIGENCE=1 bun run app:dev
```

## 当前状态

这个仓库目前处于从 Handy 向 Swil Flow 的品牌化与产品化过渡阶段。

已经完成的事项：

- Tauri 应用名切换为 `Swil Flow`
- 开发版配置切换为 `Swil Flow Dev`
- 默认更新检查关闭
- updater 配置移除
- Apple Intelligence 在非完整 Xcode 环境下自动回退

仍可能保留上游痕迹的地方：

- 某些底层二进制名
- 一些历史文档或注释
- 少量非关键的上游引用

## 后续建议

- 继续清理上游 `Handy` 文案与资产
- 接入自己的代码签名与更新源
- 梳理发布流程
- 补充面向终端用户的 macOS 安装说明

## 许可证

本项目继承上游 Handy 的 MIT License，详情见 [LICENSE](LICENSE)。
