# Build Instructions

This guide covers how to set up the development environment and build Swil Flow, a downstream fork of Handy.

## Prerequisites

### All Platforms

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager
- `cmake`
- [Tauri Prerequisites](https://tauri.app/start/prerequisites/)

### Platform-Specific Requirements

#### macOS

- Xcode Command Line Tools
- Install with: `xcode-select --install`
- Full Xcode is optional for local development
- If full Xcode is not active, Apple Intelligence support automatically falls back to stubs

#### Windows

- Microsoft C++ Build Tools
- Visual Studio 2019/2022 with C++ development tools
- Or Visual Studio Build Tools 2019/2022

#### Linux

- Build essentials
- ALSA development libraries
- Install with:

  ```bash
  # Ubuntu/Debian
  sudo apt update
  sudo apt install build-essential libasound2-dev pkg-config libssl-dev libvulkan-dev vulkan-tools glslc libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libgtk-layer-shell0 libgtk-layer-shell-dev patchelf cmake

  # Fedora/RHEL
  sudo dnf groupinstall "Development Tools"
  sudo dnf install alsa-lib-devel pkgconf openssl-devel vulkan-devel \
    gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel \
    gtk-layer-shell gtk-layer-shell-devel \
    cmake

  # Arch Linux
  sudo pacman -S base-devel alsa-lib pkgconf openssl vulkan-devel \
    gtk3 webkit2gtk-4.1 libappindicator-gtk3 librsvg gtk-layer-shell \
    cmake
  ```

## Setup Instructions

### 1. Clone the Repository

```bash
git clone <your-fork-url> swilflow
cd swilflow
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Separate Dev Data from Production

```bash
mkdir -p src-tauri/target/debug/Data
printf "Handy Portable Mode\n" > src-tauri/target/debug/portable
```

### 4. Verify the Rust Side

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

### 5. Start the Dev App

```bash
bun run app:dev
```

This launches the fork-specific dev configuration:

- Product name: `Swil Flow Dev`
- Bundle identifier: `com.supwilsoft.swilflow.dev`

### 6. Build for Production

```bash
bun run app:build
```

This builds the production-branded app:

- Product name: `Swil Flow`
- Bundle identifier: `com.supwilsoft.swilflow`

## Frontend Only Development

```bash
bun run dev
bun run build
bun run preview
```

## Notes

- Automatic updates are currently disabled in this fork
- Tauri updater artifacts are not generated
- The low-level Cargo binary name may still appear as `handy` during build output
- The portable marker string intentionally remains `Handy Portable Mode` because that is what the current runtime checks for
