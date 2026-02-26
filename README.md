# opencode-synced

Sync global opencode configuration across machines via a GitHub repo, with optional secrets support for private repos.

> **This is a community fork** of [iHildy/opencode-synced](https://github.com/iHildy/opencode-synced) that fixes session sync and adds several improvements. See [What this fork adds](#what-this-fork-adds) and [Installing from this fork](#installing-from-this-fork).

## Features

- Syncs global opencode config (`~/.config/opencode`) and related directories
- Optional secrets sync when the repo is private
- Optional session sync to share conversation history across machines (fixed for OpenCode SQLite backend)
- Optional prompt stash sync to share stashed prompts and history across machines
- Startup auto-sync with restart toast
- Per-machine overrides via `opencode-synced.overrides.jsonc`
- Custom `/sync-*` commands and `opencode_sync` tool

## Requirements

- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
- Git installed and available on PATH

## What this fork adds

The published `opencode-synced@0.9.0` npm package has several issues this fork fixes:

| Fix | Description |
|-----|-------------|
| **Session sync** | OpenCode migrated from flat-file storage to SQLite (~Feb 2026). The original plugin pointed at `storage/session/`, `storage/message/`, etc. — directories that no longer exist. This fork exports sessions via the SDK and imports them via `opencode import`. |
| **Compact mode pruning** | Sessions are exported in `compact` mode by default: old tool outputs are replaced with a placeholder (same strategy Anthropic and OpenCode itself use for context management). Full verbatim sync is available via `sessionSync.mode = "full"`. |
| **Cross-platform paths** | Session `directory` and message `path.cwd`/`path.root` fields are rewritten on import so sessions are visible when pushing from macOS (`/Users/X/...`) and pulling on Linux (`/home/X/...`). |
| **Skills sync** | `~/.config/opencode/skills/` is now included in the synced directories. |
| **Lib sync** | `~/.config/opencode/lib/` is now included, so shared modules imported by synced plugins are available on all machines. |
| **dist included** | The npm-published package is missing `dist/`. This fork includes the compiled output so it can be installed directly from GitHub. |

## Installing from this fork

The OpenCode plugin system only supports npm package names — it does not support `github:` URLs. The workaround is to clone this fork and copy the compiled `dist/` into the OpenCode plugin cache.

> **Note for LLMs**: These are the exact steps to install this plugin on a new machine. Follow them in order. Do not skip the cache patch step — without it, the plugin will load but have no commands.

### Prerequisites

```bash
# 1. Install GitHub CLI and authenticate
gh auth login

# 2. Ensure git is installed
git --version
```

### macOS

```bash
# 1. Install OpenCode (if not already installed)
npm install -g opencode-ai

# 2. Add the plugin to your OpenCode config
# Edit ~/.config/opencode/opencode.json and ensure this is present:
# "plugin": ["opencode-synced"]

# 3. Run OpenCode once to trigger the plugin cache install
opencode --version

# 4. Clone this fork and patch the cache
git clone --depth 1 --branch feat/session-sync \
  https://github.com/kshptl/opencode-synced.git /tmp/opencode-synced-fork

rm -rf ~/.cache/opencode/node_modules/opencode-synced/dist
cp -r /tmp/opencode-synced-fork/dist \
  ~/.cache/opencode/node_modules/opencode-synced/

# 5. Start OpenCode and run /sync-link or /sync-init
```

### Linux / WSL

```bash
# 1. Install OpenCode (if not already installed)
npm install -g opencode-ai

# 2. Add the plugin to your OpenCode config
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-synced"]
}
EOF

# 3. Run OpenCode once to trigger the plugin cache install
opencode --version

# 4. Clone this fork and patch the cache
git clone --depth 1 --branch feat/session-sync \
  https://github.com/kshptl/opencode-synced.git /tmp/opencode-synced-fork

rm -rf ~/.cache/opencode/node_modules/opencode-synced/dist
cp -r /tmp/opencode-synced-fork/dist \
  ~/.cache/opencode/node_modules/opencode-synced/

# 5. Start OpenCode
opencode

# 6. Run /sync-link to pull your existing config from GitHub
#    This will overwrite ~/.config/opencode with your synced config.
#    After it completes, re-patch the cache (the pull may reinstall the plugin):
rm -rf ~/.cache/opencode/node_modules/opencode-synced/dist
cp -r /tmp/opencode-synced-fork/dist \
  ~/.cache/opencode/node_modules/opencode-synced/

# 7. Restart OpenCode
```

### Keeping the fork up to date

When new changes are pushed to the fork, update your local cache:

```bash
cd /tmp/opencode-synced-fork
git pull
rm -rf ~/.cache/opencode/node_modules/opencode-synced/dist
cp -r dist ~/.cache/opencode/node_modules/opencode-synced/
# Restart OpenCode
```

### Single-command update (add to your shell profile)

```bash
alias opencode-sync-update='
  cd /tmp/opencode-synced-fork && git pull &&
  rm -rf ~/.cache/opencode/node_modules/opencode-synced/dist &&
  cp -r dist ~/.cache/opencode/node_modules/opencode-synced/ &&
  echo "opencode-synced updated. Restart OpenCode."
'
```

---

## Setup

Enable the plugin in your global opencode config (opencode will install it on next run):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-synced"],
}
```

opencode does not auto-update plugins. To update, modify the version number in your config file.

## Configure

### First machine (create new sync repo)

Run `/sync-init` to create a new sync repo:

1. Detects your GitHub username
2. Creates a private repo (`my-opencode-config` by default)
3. Clones the repo and pushes your current config

### Additional machines (link to existing repo)

Run `/sync-link` to connect to your existing sync repo:

1. Searches your GitHub for common sync repo names (prioritizes `my-opencode-config`)
2. Clones and applies the synced config
3. **Overwrites local config** with synced content (preserves your local overrides file)

If auto-detection fails, specify the repo name: `/sync-link my-opencode-config`

After linking, restart opencode to apply the synced settings.

### Custom repo name or org

You can specify a custom repo name or use an organization:

- `/sync-init` - Uses `{your-username}/my-opencode-config`
- `/sync-init my-config` - Uses `{your-username}/my-config`
- `/sync-init my-org/team-config` - Uses `my-org/team-config`

<details>
<summary>Manual configuration</summary>

Create `~/.config/opencode/opencode-synced.jsonc`:

```jsonc
{
  "repo": {
    "owner": "your-org",
    "name": "opencode-config",
    "branch": "main",
  },
  "includeSecrets": false,
  "includeMcpSecrets": false,
  "includeSessions": false,
  "includePromptStash": false,
  "includeModelFavorites": true,
  "extraSecretPaths": [],
  "extraConfigPaths": [],
}
```

</details>

### Synced paths (default)

- `~/.config/opencode/opencode.json` and `opencode.jsonc`
- `~/.config/opencode/AGENTS.md`
- `~/.config/opencode/agent/`, `command/`, `mode/`, `tool/`, `themes/`, `plugin/`
- `~/.config/opencode/skills/` — agent skills
- `~/.config/opencode/lib/` — shared modules used by plugins
- `~/.local/state/opencode/model.json` (model favorites)
- Any extra paths in `extraConfigPaths` (allowlist, files or folders)

### Secrets (private repos only)

Enable secrets with `/sync-enable-secrets` or set `"includeSecrets": true`:

- `~/.local/share/opencode/auth.json`
- `~/.local/share/opencode/mcp-auth.json`
- Any extra paths in `extraSecretPaths` (allowlist, files or folders)

MCP API keys stored inside `opencode.json(c)` are **not** committed by default. To allow them
in a private repo, set `"includeMcpSecrets": true` (requires `includeSecrets`).

### Sessions (private repos only)

Sync your opencode conversation history across machines by setting `"includeSessions": true`.

```jsonc
{
  "repo": { ... },
  "includeSecrets": true,
  "includeSessions": true,
  "sessionSync": {
    "mode": "compact",           // "compact" (default) | "full"
    "keepRecentToolResults": 5   // number of recent tool outputs to keep unredacted
  }
}
```

Sessions are exported via the OpenCode SDK and stored as NDJSON files in the sync repo under `data/sessions/`. On pull, missing sessions are imported via `opencode import` with path rewriting for cross-platform compatibility (macOS ↔ Linux).

**Compact mode** (default): old tool result outputs are replaced with `[Synced: tool output cleared]` — the same strategy OpenCode itself uses for context management. The last N tool results (default: 5) are kept in full. This reduces session size by 90%+ while preserving full conversation continuity.

**Full mode**: syncs everything verbatim.

**Append-only semantics**: sessions deleted locally are not deleted from the sync repo or from other machines on pull. The sync repo acts as a historical archive.

**Cross-platform note**: session `directory` and message `path.cwd`/`path.root` fields are rewritten on import to match the local project directory, so sessions pushed from macOS (`/Users/X/project`) are visible on Linux (`/home/X/project`).

### Prompt Stash (private repos only)

Sync your stashed prompts and prompt history across machines by setting `"includePromptStash": true`. This requires `includeSecrets` to also be enabled since prompts may contain sensitive data.

```jsonc
{
  "repo": { ... },
  "includeSecrets": true,
  "includePromptStash": true
}
```

Synced prompt data:

- `~/.local/state/opencode/prompt-stash.jsonl` - Stashed prompts
- `~/.local/state/opencode/prompt-history.jsonl` - Prompt history

## Overrides

Create a local-only overrides file at:

```
~/.config/opencode/opencode-synced.overrides.jsonc
```

Overrides are merged into the runtime config and re-applied to `opencode.json(c)` after pull.

### MCP secret scrubbing

If your `opencode.json(c)` contains MCP secrets (for example `mcp.*.headers` or `mcp.*.oauth.clientSecret`), opencode-synced will automatically:

1. Move the secret values into `opencode-synced.overrides.jsonc` (local-only).
2. Replace the values in the synced config with `{env:...}` placeholders.

This keeps secrets out of the repo while preserving local behavior. On other machines, set the matching environment variables (or add local overrides).
If you want MCP secrets committed (private repos only), set `"includeMcpSecrets": true` alongside `"includeSecrets": true`.

Env var naming rules:

- If the header name already looks like an env var (e.g. `CONTEXT7_API_KEY`), it is used directly.
- Otherwise: `opencode_mcp_<SERVER>_<HEADER>` (non-alphanumerics become `_`).
- OAuth client secrets use `opencode_mcp_<SERVER>_OAUTH_CLIENT_SECRET`.

## Usage

| Command | Description |
|---------|-------------|
| `/sync-init` | Create a new sync repo (first machine) |
| `/sync-link` | Link to existing sync repo (additional machines) |
| `/sync-status` | Show repo status and last sync times |
| `/sync-pull` | Fetch and apply remote config |
| `/sync-push` | Commit and push local changes |
| `/sync-enable-secrets` | Enable secrets sync (private repos only) |
| `/sync-resolve` | Auto-resolve uncommitted changes using AI |

<details>
<summary>Manual sync (without slash commands)</summary>

### Trigger a sync

Restart opencode to run the startup sync flow (pull remote, apply if changed, push local changes if needed).

### Check status

Inspect the local repo directly:

```bash
cd ~/.local/share/opencode/opencode-synced/repo
git status
git log --oneline -5
```

</details>

## Recovery

If the sync repo has uncommitted changes, you can:

1. **Auto-resolve using AI**: Run `/sync-resolve` to let AI analyze and decide whether to commit or discard the changes
2. **Manual resolution**: Navigate to the repo and resolve manually:

```bash
cd ~/.local/share/opencode/opencode-synced/repo
git status
git pull --rebase
```

Then re-run `/sync-pull` or `/sync-push`.

## Removal

<details>
<summary>How to completely remove and delete opencode-synced</summary>

Run this one-liner to remove the plugin from your config, delete local sync files, and delete the GitHub repository:

```bash
bun -e '
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawnSync } = require("node:child_process");
  const isWin = os.platform() === "win32", home = os.homedir();
  const configDir = isWin ? path.join(process.env.APPDATA, "opencode") : path.join(home, ".config", "opencode");
  const dataDir = isWin ? path.join(process.env.LOCALAPPDATA, "opencode") : path.join(home, ".local", "share", "opencode");
  ["opencode.json", "opencode.jsonc"].forEach(f => {
    const p = path.join(configDir, f);
    if (fs.existsSync(p)) {
      const c = fs.readFileSync(p, "utf8"), u = c.replace(/"opencode-synced"\s*,?\s*/g, "").replace(/,\s*\]/g, "]");
      if (c !== u) fs.writeFileSync(p, u);
    }
  });
  const scp = path.join(configDir, "opencode-synced.jsonc");
  if (fs.existsSync(scp)) {
    try {
      const c = JSON.parse(fs.readFileSync(scp, "utf8").replace(/\/\/.*/g, ""));
      if (c.repo?.owner && c.repo?.name) {
        const res = spawnSync("gh", ["repo", "delete", `${c.repo.owner}/${c.repo.name}`, "--yes"], { stdio: "inherit" });
        if (res.status !== 0) console.log("\nNote: Repository delete failed. If it is a permission error, run: gh auth refresh -s delete_repo\n");
      }
    } catch (e) {}
  }
  [scp, path.join(configDir, "opencode-synced.overrides.jsonc"), path.join(dataDir, "sync-state.json"), path.join(dataDir, "opencode-synced")].forEach(p => {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  });
  console.log("opencode-synced removed.");
'
```

### Manual steps
1. Remove `"opencode-synced"` from the `plugin` array in `~/.config/opencode/opencode.json` (or `.jsonc`).
2. Delete the local configuration and state:
   ```bash
   rm ~/.config/opencode/opencode-synced.jsonc
   rm ~/.local/share/opencode/sync-state.json
   rm -rf ~/.local/share/opencode/opencode-synced
   ```
3. (Optional) Delete the backup repository on GitHub via the web UI or `gh repo delete`.

</details>

## Development

- `bun run build`
- `bun run test`
- `bun run lint`

### Local testing (production-like)

To test the same artifact that would be published, install from a packed tarball
into opencode's cache:

```bash
mise run local-pack-test
```

Then set `~/.config/opencode/opencode.json` to use:

```jsonc
{
  "plugin": ["opencode-synced"]
}
```

Restart opencode to pick up the cached install.


## Prefer a CLI version?

I stumbled upon [opencodesync](https://www.npmjs.com/package/opencodesync) while publishing this plugin.
