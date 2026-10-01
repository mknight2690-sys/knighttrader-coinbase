# KnightTrader Propr

Desktop launcher for Hermes + Propr challenge auto-trading on Windows, Mac, and Linux.

## Linux quick start

### Download options

- **AppImage** — portable single file
- **tar.gz** — extract and run `./knighttrader-propr` (no FUSE required)
- **run-knighttrader-propr.sh** — helper that uses `--appimage-extract-and-run` when FUSE/libfuse2 is missing

```bash
chmod +x run-knighttrader-propr.sh KnightTrader-Propr-*.AppImage
./run-knighttrader-propr.sh
```

Or without the helper:

```bash
chmod +x KnightTrader-Propr-*.AppImage
./KnightTrader-Propr-*.AppImage --appimage-extract-and-run
```

### Credentials without the GUI

Set keys in the environment or in the Hermes config folder:

```bash
export NOUS_API_KEY="your-nous-portal-key"
export PROPR_API_KEY="pk_live_..."
# optional
export PROPR_ACCOUNT_ID="..."
```

Config folder (default):

`~/.config/knight-trader-propr/hermes-propr/.env`

Hermes reads `NOUS_API_KEY` / `NOUSRESEARCH_API_KEY` from that `.env` file.

### Headless one-shot tasks (no window)

Run a single Hermes agent task, print the result, save a log, and exit. No cron, no trading tab, no dashboard required for the one-shot itself.

```bash
./knighttrader-propr --appimage-extract-and-run --headless --task "Reply with exactly: PONG"
```

From a file:

```bash
./knighttrader-propr --headless --task-file task.txt
```

Paper-only safety switch (blocks Propr order API mutations):

```bash
./knighttrader-propr --headless --paper-only --task "Analyze SOL setup without placing orders"
```

Logs are written under:

`~/.config/knight-trader-propr/hermes-propr/logs/headless-*.log`

### First-time Hermes install on Linux

The app installs Hermes with `install.sh` (bash) — not PowerShell. Open the app once and click **Install Hermes**, or run a headless task and the installer runs automatically if Hermes is missing.

Requirements: `bash`, `curl`, `python3`, and network access.

## Windows

Unchanged — Hermes installs via PowerShell using the official `install.ps1`.

## Releases

Tagged pushes build Windows, Mac, and Linux artifacts via GitHub Actions.
