# Doubao Batch Image Generation Desktop Software

Desktop software for automated batch image generation from Doubao web version - automatically extracts original watermark-free images.

## Features

- **Multi-project management**: Manage multiple image generation projects independently, each with prompts and reference images
- **Folder-independent extraction**: Extract reference images by folder independently, fixed 5 images per round
- **Multi-account independent login**: Each Doubao account uses an independent Chromium user data directory, login state persisted
- **Multi-project task queue**: Serially execute multiple project tasks, support pause, resume, cancel
- **Original image extraction**: Extract original watermark-free image URLs directly returned by Doubao web page, retain original format (JPG/PNG/WEBP etc.)
- **Download verification**: SHA-256 hash verification, file size and content integrity check
- **Task state machine**: Supports pending/preparing/selecting_images/uploading/submitting/generating/downloading/verifying/completed/paused/failed/cancelled/needs_manual_intervention states
- **Exception recovery**: Handles login failure, CAPTCHA, web page structure changes, pauses and waits for manual handling
- **Internationalization**: Supports Simplified Chinese and English

## Architecture

- **Desktop Framework**: Tauri 2 (Rust + React)
- **Automation Runtime**: Node.js + Playwright Chromium (Sidecar mode)
- **Database**: SQLite
- **Communication**: Tauri Commands / Events

## Quick Start

### Requirements

- Node.js >= 20
- Rust >= 1.70
- Windows 10/11

### Install & Run

```bash
# Clone repository
git clone <repository-url>
cd ai-image-generate

# Install frontend dependencies
npm install

# Build frontend
npm run build

# Check Rust backend
cargo check --manifest-path src-tauri/Cargo.toml

# Start in dev mode
cargo tauri dev
```

## Project Structure

```
ai-image-generate/
├── docs/                 # Technical documentation
├── prototype/            # Phase 1 prototype (Node.js + Playwright)
├── src/                  # React frontend
├── src-tauri/            # Rust backend (Tauri 2)
├── sidecar/              # Node.js automation runtime
├── task.md               # Development task document
└── README_EN.md
```

## Development Stages

- Phase 0: Technical research and validation report
- Phase 1: Minimum viable prototype
- Phase 2: Basic application (Tauri + React + Rust + SQLite)
- Phase 3: Image and task system
- Phase 4: Result management
- Phase 5: UI completion
- Phase 6: Installation and update
- Phase 7: Complete testing

## License

MIT License