---
name: backup
description: Create a portable backup zip of NanoClaw data (credentials, groups, config, sessions) for migration to another machine. Saves to Obsidian vault. Keeps max 3 backups, auto-deletes oldest. Use when migrating to a new server or creating a restore point.
---

# NanoClaw Backup

Creates a timestamped backup zip of all runtime state needed to restore NanoClaw on another machine. Source code is not backed up — use git for that.

## What gets backed up

| Path | Contents |
|------|----------|
| `.env` | API tokens, bot tokens, all secrets |
| `groups/` | Per-group CLAUDE.md memory and user files |
| `store/` | WhatsApp auth credentials + `messages.db` |
| `.nanoclaw/state.yaml` | Applied skills tracker |
| `data/sessions/` | Per-group Claude Code session state |
| `~/.config/nanoclaw/` | `mount-allowlist.json`, `sender-allowlist.json` |

**Not backed up:** `node_modules/`, `dist/`, `logs/`, `data/ipc/`, `data/media/`

## Steps

### 1. Set up paths

Read `OBSIDIAN_PATH` from `.env`. Project root is the current working directory.

```bash
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_NAME="nanoclaw-backup-${TIMESTAMP}"
BACKUP_DIR="/tmp/${BACKUP_NAME}"
PROJECT_ROOT=$(pwd)
OBSIDIAN_PATH="..."  # from .env — convert Windows separators to Unix for bash
OBSIDIAN_DEST="${OBSIDIAN_PATH}/resources/nanoclaw-backups"
```

If `OBSIDIAN_PATH` is not set in `.env`, ask the user where to save the backup before continuing.

### 2. Enforce 3-backup limit

Before creating the new backup, check how many backups already exist in the Obsidian destination:

```bash
mkdir -p "${OBSIDIAN_DEST}"

# List existing backups sorted oldest-first
EXISTING=$(ls -1t "${OBSIDIAN_DEST}"/nanoclaw-backup-*.zip 2>/dev/null | tail -r)
COUNT=$(echo "${EXISTING}" | grep -c '.zip' || true)

# If 3 or more exist, delete the oldest until we're at 2
while [ "${COUNT}" -ge 3 ]; do
  OLDEST=$(echo "${EXISTING}" | head -1)
  echo "Removing oldest backup: ${OLDEST}"
  rm "${OLDEST}"
  EXISTING=$(ls -1t "${OBSIDIAN_DEST}"/nanoclaw-backup-*.zip 2>/dev/null | tail -r)
  COUNT=$(echo "${EXISTING}" | grep -c '.zip' || true)
done
```

On macOS/Linux `tail -r` reverses order; on Linux use `tac` instead. On Windows bash (Git Bash), `tail -r` may not work — use `ls -1 | sort` instead.

### 3. Stage backup files

```bash
mkdir -p "${BACKUP_DIR}"

cp "${PROJECT_ROOT}/.env" "${BACKUP_DIR}/.env" 2>/dev/null || true

[ -d "${PROJECT_ROOT}/groups" ] && cp -r "${PROJECT_ROOT}/groups" "${BACKUP_DIR}/groups"

[ -d "${PROJECT_ROOT}/store" ] && cp -r "${PROJECT_ROOT}/store" "${BACKUP_DIR}/store"

mkdir -p "${BACKUP_DIR}/.nanoclaw"
cp "${PROJECT_ROOT}/.nanoclaw/state.yaml" "${BACKUP_DIR}/.nanoclaw/state.yaml" 2>/dev/null || true

# Copy sessions skipping symlinks (Windows Git Bash doesn't support them in /tmp)
if [ -d "${PROJECT_ROOT}/data/sessions" ]; then
  find "${PROJECT_ROOT}/data/sessions" -not -type l | while read f; do
    rel="${f#${PROJECT_ROOT}/data/sessions}"
    dest="${BACKUP_DIR}/data_sessions${rel}"
    if [ -d "$f" ]; then mkdir -p "$dest"; else cp "$f" "$dest" 2>/dev/null || true; fi
  done
fi

NANOCLAW_CONFIG="${HOME}/.config/nanoclaw"
if [ -d "${NANOCLAW_CONFIG}" ]; then
  mkdir -p "${BACKUP_DIR}/nanoclaw-config"
  cp "${NANOCLAW_CONFIG}/mount-allowlist.json" "${BACKUP_DIR}/nanoclaw-config/" 2>/dev/null || true
  cp "${NANOCLAW_CONFIG}/sender-allowlist.json" "${BACKUP_DIR}/nanoclaw-config/" 2>/dev/null || true
fi
```

### 4. Write RESTORE.md

Create `${BACKUP_DIR}/RESTORE.md`:

```
# NanoClaw Restore Instructions

Backup created: {TIMESTAMP}
Source machine: {HOSTNAME}  (run: hostname)

## Quick restore (Ubuntu server)

1. Install prerequisites:
   sudo apt-get update && sudo apt-get install -y nodejs npm docker.io
   sudo usermod -aG docker $USER  # then log out and back in

2. Clone your fork and install:
   git clone https://github.com/YOUR_FORK/nanoclaw.git
   cd nanoclaw && npm install && npm run build

3. Copy files from this zip into the project root:
   cp .env /path/to/nanoclaw/
   cp -r groups /path/to/nanoclaw/
   cp -r store /path/to/nanoclaw/
   cp .nanoclaw/state.yaml /path/to/nanoclaw/.nanoclaw/
   cp -r data_sessions /path/to/nanoclaw/data/sessions   # optional

4. Restore system config:
   mkdir -p ~/.config/nanoclaw
   cp nanoclaw-config/*.json ~/.config/nanoclaw/

5. Build container image:
   cd /path/to/nanoclaw && ./container/build.sh

6. Start the service:
   npm start

## Notes
- WhatsApp auth (store/auth/) is device-paired; new machine may need QR re-scan.
- Telegram is token-based — no session restore needed.
- data_sessions/ is optional — omitting only loses Claude session history.
- Run /restore in Claude Code for guided interactive restore.
```

Replace `{TIMESTAMP}` and `{HOSTNAME}` with actual values.

### 5. Create the zip

**On Windows (Git Bash):** `zip` is not available — use .NET ZipFile via PowerShell (avoids Compress-Archive temp file locking issues):

```bash
WIN_SRC=$(cygpath -w "${BACKUP_DIR}")
WIN_DST=$(cygpath -w "/tmp/${BACKUP_NAME}.zip")
cat > /tmp/do_zip.ps1 << EOF
Add-Type -Assembly 'System.IO.Compression.FileSystem'
\$level = [System.IO.Compression.CompressionLevel]::Optimal
[System.IO.Compression.ZipFile]::CreateFromDirectory('${WIN_SRC}', '${WIN_DST}', \$level, \$true)
Write-Output "Done"
EOF
powershell.exe -File "$(cygpath -w /tmp/do_zip.ps1)"
ZIPFILE="/tmp/${BACKUP_NAME}.zip"
rm -f /tmp/do_zip.ps1
```

**On Linux/macOS:**
```bash
cd /tmp && zip -r "${BACKUP_NAME}.zip" "${BACKUP_NAME}/"
ZIPFILE="/tmp/${BACKUP_NAME}.zip"
```

### 6. Copy to Obsidian

```bash
cp "${ZIPFILE}" "${OBSIDIAN_DEST}/"
echo "Saved: ${OBSIDIAN_DEST}/${BACKUP_NAME}.zip"
ls -lh "${OBSIDIAN_DEST}/"
```

### 7. Clean up

```bash
rm -rf "${BACKUP_DIR}"
# Also remove the /tmp zip if it differs from OBSIDIAN_DEST
rm -f "${ZIPFILE}"
```

### 8. Report to user

Tell the user:
- Filename and size of the new backup
- How many backups now exist and their filenames
- If any old backup was deleted, which one
- How to link to it in an Obsidian note: `[[nanoclaw-backups/nanoclaw-backup-YYYY-MM-DD_HHMMSS.zip]]`
- Remind them to run `/restore` on the target machine to do a guided restore
