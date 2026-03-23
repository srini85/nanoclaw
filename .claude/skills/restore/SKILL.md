---
name: restore
description: Restore NanoClaw from a backup zip on a new machine. Guides through extracting credentials, groups, config, and sessions. Use after cloning the repo on a new server to restore state from a /backup zip.
---

# NanoClaw Restore

Guided restore of NanoClaw state from a backup zip created by `/backup`. Run this on the target machine after cloning the repo.

## Prerequisites

Before restoring, the target machine needs:
- Node.js 24+
- npm
- Docker (for container agent support)
- The nanoclaw repo cloned and dependencies installed (`npm install && npm run build`)
- The backup zip file transferred to the machine

## Steps

### 1. Locate the backup zip

Ask the user: "Where is the backup zip? (provide the full path to the nanoclaw-backup-*.zip file)"

If the user has it in their Obsidian vault, the default location would be:
`{OBSIDIAN_PATH}/resources/nanoclaw-backups/nanoclaw-backup-*.zip`

List available backups if the Obsidian path is known:
```bash
OBSIDIAN_PATH="..."  # ask if not known
ls -lt "${OBSIDIAN_PATH}/resources/nanoclaw-backups/"nanoclaw-backup-*.zip 2>/dev/null
```

### 2. Extract the backup

```bash
ZIPFILE="/path/to/nanoclaw-backup-YYYY-MM-DD_HHMMSS.zip"
EXTRACT_DIR="/tmp/nanoclaw-restore"
rm -rf "${EXTRACT_DIR}"
mkdir -p "${EXTRACT_DIR}"

# Linux/macOS:
unzip "${ZIPFILE}" -d "${EXTRACT_DIR}"

# Windows (Git Bash):
WIN_ZIPFILE=$(cygpath -w "${ZIPFILE}")
WIN_EXTRACT=$(cygpath -w "${EXTRACT_DIR}")
powershell.exe -Command "Expand-Archive -Path '${WIN_ZIPFILE}' -DestinationPath '${WIN_EXTRACT}' -Force"
```

After extraction there will be a subdirectory named `nanoclaw-backup-*` — navigate into it:
```bash
BACKUP_ROOT="${EXTRACT_DIR}/$(ls ${EXTRACT_DIR})"
```

### 3. Confirm project root

Ask: "What is the full path to the nanoclaw project directory on this machine?"

```bash
PROJECT_ROOT="/path/to/nanoclaw"  # user-provided
```

Verify it exists and has `package.json`:
```bash
[ -f "${PROJECT_ROOT}/package.json" ] && echo "OK" || echo "ERROR: not a nanoclaw directory"
```

### 4. Restore files (with confirmation per step)

Show the user what will be restored and ask them to confirm each item:

**a) .env (required)**
```bash
cp "${BACKUP_ROOT}/.env" "${PROJECT_ROOT}/.env"
echo "Restored .env"
```
Warn: this overwrites the current `.env` — confirm before proceeding if one already exists.

**b) groups/ (per-group memory)**
```bash
cp -r "${BACKUP_ROOT}/groups/." "${PROJECT_ROOT}/groups/"
echo "Restored groups/"
```

**c) store/ (auth credentials)**
```bash
cp -r "${BACKUP_ROOT}/store/." "${PROJECT_ROOT}/store/"
echo "Restored store/"
```
Note: WhatsApp auth (`store/auth/creds.json`) is device-paired. It may work if the IP/device fingerprint is similar, but a new machine often requires re-authentication (QR scan). Ask user: "Do you want to restore WhatsApp credentials, or skip and re-authenticate?" If skipping, exclude `store/auth/`.

**d) .nanoclaw/state.yaml (applied skills)**
```bash
mkdir -p "${PROJECT_ROOT}/.nanoclaw"
cp "${BACKUP_ROOT}/.nanoclaw/state.yaml" "${PROJECT_ROOT}/.nanoclaw/state.yaml"
echo "Restored .nanoclaw/state.yaml"
```

**e) data/sessions/ (Claude session history — optional)**
```bash
mkdir -p "${PROJECT_ROOT}/data/sessions"
cp -r "${BACKUP_ROOT}/data_sessions/." "${PROJECT_ROOT}/data/sessions/"
echo "Restored data/sessions/"
```
This is optional — skipping only means the agent starts fresh sessions per group.

**f) System config files**
```bash
mkdir -p "${HOME}/.config/nanoclaw"
[ -f "${BACKUP_ROOT}/nanoclaw-config/mount-allowlist.json" ] && \
  cp "${BACKUP_ROOT}/nanoclaw-config/mount-allowlist.json" "${HOME}/.config/nanoclaw/"
[ -f "${BACKUP_ROOT}/nanoclaw-config/sender-allowlist.json" ] && \
  cp "${BACKUP_ROOT}/nanoclaw-config/sender-allowlist.json" "${HOME}/.config/nanoclaw/"
echo "Restored ~/.config/nanoclaw/"
```

### 5. Build the container image

```bash
cd "${PROJECT_ROOT}"
./container/build.sh
```

### 6. Verify and start

```bash
cd "${PROJECT_ROOT}"
npm run build
npm start
```

Check that the service starts without errors. If Telegram is configured it should connect immediately. If WhatsApp credentials were restored, it should reconnect without a QR scan — otherwise it will display a QR code for re-pairing.

### 7. Clean up

```bash
rm -rf "${EXTRACT_DIR}"
```

### 8. Report to user

Tell the user:
- Which files were restored
- Which were skipped and why
- Whether they need to re-authenticate WhatsApp
- Next steps (e.g. if `npm start` fails, run `/debug`)

## Troubleshooting

**WhatsApp won't connect after restore:** The session is device-paired. Delete `store/auth/` and restart — the bot will show a QR code to re-pair.

**Telegram not responding:** Check that `TELEGRAM_BOT_TOKEN` in `.env` matches the bot registered with @BotFather.

**Container fails to start:** Run `/debug` for guided diagnosis.

**`npm run build` fails:** Dependencies may be missing — run `npm install` first.

**Permission denied on docker socket:** Run `sudo usermod -aG docker $USER` then log out and back in.
