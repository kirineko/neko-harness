# neko-harness

**English** | [简体中文](docs/README.zh-CN.md)

A local AI coding assistant for the terminal, the browser and your phone: it reads and edits files in your project, runs commands, accepts images, searches the web, calls skills and delegates to subagents. Sessions are saved automatically.

> The Chinese version is the master copy. If this page and [`docs/README.zh-CN.md`](docs/README.zh-CN.md) disagree, the Chinese page is correct.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [First run](#first-run)
- [Features](#features)
- [Plan mode](#plan-mode)
- [Configuration](#configuration)
- [Security](#security)
- [Upgrade](#upgrade)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Requirements

- **Bun 1.4.2** (any 1.4.x release) — see the [Bun installation guide](https://bun.sh/docs/installation). If `neko` is not found afterwards, add Bun's bin directory to `PATH` (`~/.bun/bin`, on Windows `%USERPROFILE%\.bun\bin`).
- macOS, Linux or Windows. **Windows also needs [Git for Windows](https://git-scm.com/download/win)**: the bash tool, background jobs and subagents run through Git Bash, which neko finds automatically (`shell.path` overrides the lookup).
- A model API key. DeepSeek works out of the box; 31 other API-key providers can be enabled.

## Quick start

```bash
bun add --global neko-harness

cd /path/to/your/project
neko tui   # terminal UI
neko web   # browser UI
```

`neko` starts the interface you asked for and, when no gateway is running yet, a gateway — the process that owns sessions, tools and the mobile endpoint.

| Command | What it starts |
| --- | --- |
| `neko tui` | Terminal UI; starts a gateway on demand. The TUI talks to it over a Unix socket on POSIX and over a local WebSocket on Windows. |
| `neko web` | Web UI on `http://127.0.0.1:8322` with a gateway WebSocket on `127.0.0.1:8321`; reuses a gateway another UI already started, and opens the browser unless `--no-open` is given. |
| `neko serve` | Gateway only: WebSocket on `127.0.0.1:8321` plus a Unix socket on POSIX. Keeps sessions, background jobs and the phone endpoint available without any UI. |

Both UIs can run at the same time and share one gateway. The process that started the gateway stops it when it exits, so use `neko serve` when the gateway should outlive the UI — for example to keep a paired phone connected after closing the browser page.

## First run

In the TUI run `/login`; in the web UI open **设置 → 模型服务** (settings → model providers). Paste a [DeepSeek API key](https://platform.deepseek.com/api_keys) and save it. The default model is `deepseek/deepseek-flash` (DeepSeek V4.1 Flash); pick another from the model picker, and change the thinking level with `/think` in the TUI.

Keys can come from environment variables instead (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `TAVILY_API_KEY`, …). A key saved in the UI wins over the environment, and keys stay on this machine.

**Other providers.** Besides DeepSeek there are 31 API-key providers (OpenRouter, OpenCode Go / Zen, OpenAI, Google, Groq, Mistral, xAI, Together, …). Enable one in `/login` (space toggles it) or in **设置 → 模型服务**, then save its key or export its environment variable — the provider card in the web settings shows the exact name. Enabled providers appear in `/model` and in the composer's model picker. Disabling a provider keeps its saved key but blocks sending in sessions that use it, until you re-enable the provider or switch those sessions to another model. `--model` takes `provider/modelId`, for example `openrouter/anthropic/claude-haiku-4.5`.

**Default model.** Choose a model and set it as the default for new sessions: the ☆ action in the web picker (设为默认) or `d` in the TUI `/model` list, pressing `d` again to clear it. Precedence: `--model` > saved default > `defaultModel` in the config file > built-in DeepSeek Flash. Only sessions created afterwards are affected.

## Features

### Workspace and files

- The workspace is the directory neko was started in (`--cwd` overrides it). The assistant is not sandboxed to it.
- Web sidebar: add and switch projects, browse the file tree, list the changes this session produced (with diffs), and open the folder in VS Code or the file manager — opening it works only from the machine running the web server.
- Type `@` to reference a file or directory. Images: `Ctrl+V` in the TUI (`Alt+V` on Windows and WSL, where the terminal handles paste itself); paste, drop or pick files in the web UI. Whether a model accepts images depends on the model.
- Sessions: `/new` and `/sessions` in the TUI, the sidebar in the web UI; `/fork` and `/archive` in the TUI, archive from the web sidebar.

### Conversation and queue

- Sending while a run is busy queues the message instead of interrupting it. The queue bar (above the composer in the web UI, `Alt+↑` in the TUI) lists what is waiting, and every entry can be **steered** (引导) into the running work after the current tool round or **withdrawn** (撤回) back into the editor.
- TUI queue keys: `Alt+↑` selects, `↑`/`↓` moves, `Enter` steers the selected message, `Esc` withdraws it without stopping the run.
- `Esc` on the running session stops the current run.

### Context and export

- `/compact` compacts the conversation and accepts optional instructions. Automatic compaction follows pi-durable's native policy — it triggers close to the model window; tune the trigger percentage, the keep-recent budget and on/off in TUI `/context`, in web **设置 → 上下文**, or in the config file (`context.compaction`). A value saved in the UI wins over the config file.
- Tool result pruning is off by default. With `context.pruning` enabled, old tool results become placeholders in the model context once usage crosses a threshold; the transcript, projections and exports keep the originals, and the model re-runs a tool when it needs the data again. `/context` and the settings page expose the knobs.
- Copy and export: the web UI copies an answer without its reasoning and exports Markdown, HTML or JSON from the top bar (thinking included on request). TUI: `/copy` and `/export [path] [--thinking]`; without a path the file goes into the workspace, and an existing file is never overwritten.

### Agent capabilities

- **Skills.** `/skill:` completes installed skills; browse and install them from the market in the web sidebar (**技能市场**) or with TUI `/skills`. The prompt carries only the skill list — a body is read when the skill is invoked.
- **Subagents.** The assistant delegates exploration, planning or coding work, waits for the result and integrates it. Delegation cards and the sidebar in the web UI, `/agents` in the TUI; stop the current round without losing the agent's context. Bash commands from an explore subagent need one approval each.
- **Background jobs.** The `job` tool moves long commands (`npm run dev`, `uv run …`) to the background, up to 4 at a time. When one finishes the assistant is told and keeps going; live output and manual stops live in the web top bar **任务** and TUI `/jobs`. Jobs still running when the gateway restarts are marked lost and never re-run.
- **Todos.** For multi-step work the assistant keeps an ordered, read-only todo list. Web top bar **待办 n/m**, TUI `/todos`, progress entry on the mobile chat page. It is saved with the session and survives restarts and compaction; subagents cannot use it.
- **Questions.** When a decision is missing, the assistant asks with `ask_user`: single or multiple choice — a recommended option is marked but never preselected — with optional text, or skip. Answer above the composer in the web UI, with `Ctrl+O` or `/question` in the TUI, or on the mobile chat page. The answer counts only once submitted (`Enter` in the TUI); the assistant stays paused meanwhile and messages you send queue behind the answer. Questions and options are plain text.
- **Web search.** Tavily by default — keyless mode is rate-limited until you add a key — or DeepSeek search and fetch, reusing your DeepSeek key. Pick the provider in web **设置 → 联网搜索**, TUI `/search`, or `webSearch.provider` in the config file. DeepSeek search bills per successful request (CNY 5 per 1000).

### Clients

**Web** — chat, workspace sidebar (files, changes, open in editor), skill market (技能市场), and settings (设置): `/settings` 模型服务, `/settings/search` 联网搜索, `/settings/context` 上下文, `/settings/mobile` 手机配对, `/about` 版本与更新. The web UI ships Chinese labels; they are quoted as shown, with a short gloss where it helps.

**TUI** — `/` completes commands, `@` files and `/skill:` skills; `/help` lists every shortcut and command.

| Commands | What they do |
| --- | --- |
| `/login`, `/model`, `/think` | providers and keys, model, thinking level |
| `/new`, `/sessions`, `/fork`, `/archive` | sessions |
| `/compact`, `/context` | compaction, pruning and their settings |
| `/copy`, `/export` | copy the last answer, export the session |
| `/agents`, `/jobs`, `/todos`, `/question`, `/plan` | delegated work, background jobs, todos, questions, plan mode |
| `/search`, `/skills`, `/theme`, `/language`, `/version`, `/help` | search provider, skill market, theme, language, version and updates, shortcuts |

The terminal theme comes from `--theme light|dark|auto` (default `auto`), the `NEKO_THEME` environment variable, or `/theme`.

The interface language (`zh` by default, or `en`) comes from `--lang zh|en`, the `NEKO_LANG` environment variable, or `/language`; the choice is saved. The Web UI (Settings → Language) and the mobile app keep their own language setting.

**Mobile (beta)** — an Android app ([Flutter](apps/mobile/README.md)) that drives the agent over your LAN. In web **设置 → 手机配对**, show the QR code and scan it with the app. The phone must be on the same network and the firewall must allow the port; under WSL's default NAT the port is forwarded through `powershell.exe` automatically. The app trusts only the certificate fingerprint it received while pairing, so revoke a device or regenerate the certificate on the same page when needed. APKs are attached to [GitHub Releases](https://github.com/kirineko/neko-harness/releases) as `NekoAI-v<version>-<abi>.apk` (arm64-v8a, armeabi-v7a, x86_64). This is a beta: builds use a debug signature, so upgrading means uninstalling, reinstalling and pairing again, and there is no in-app update.

## Plan mode

Read-only planning with an explicit approval step.

- **Enter and leave.** TUI: `/plan` or `Shift+Tab` — idle sessions only. Web: `/plan` in the composer. While the mode is on, the composer shows a **规划模式（只读）** badge.
- **What the assistant may do.** Read files, search the code base, use the web, keep todos, ask questions and run read-only bash (listing, searching, `git log`/`diff`/`status`, version checks). `edit`, `write`, `job` and any command that changes files, installs packages or starts processes are rejected — the tools are removed from the agent, a `beforeTool` guard checks the rest, and bash is checked again when it executes (a guard rail, not a sandbox). Explore and plan subagents are allowed; the coder subagent is not.
- **Submitting.** Once it understands the task the assistant calls `submit_plan` once, alone in its turn, with a short title, ordered steps and an optional note (risks, assumptions, verification). The round ends and the session goes idle, waiting for your decision.
- **Deciding.** The plan card sits above the composer in the web UI; in the TUI a panel opens by itself. **批准并执行** (approve and execute) leaves plan mode and submits the plan as the next input, so execution starts immediately. **要求修改** (request changes) takes a note, keeps plan mode, and the assistant revises and submits again. **取消并退出计划模式** (cancel and leave plan mode) cancels the waiting plan (web button, TUI `X`). TUI keys: `↑`/`↓` choose, `A` approves, `R` writes changes, `X` cancels and exits, `Esc` closes the panel without deciding.
- **Edge cases.** Sending a normal message while a plan waits replaces that plan. Stopping the session or leaving plan mode cancels it; a restart keeps it. The mode and the last 5 plans are saved with the session, and a forked session inherits them.
- **Mobile.** A paired phone can read a plan and approve, request changes, or cancel and exit; it cannot enter plan mode. Mode changes and decisions are accepted only while the session is idle.

## Configuration

### Command line

CLI flags > config file > built-in defaults. `neko tui --help`, `neko web --help` and `neko serve --help` list every option.

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--cwd <dir>` | tui, web, serve | Workspace for the session's tools (default: the current directory). Not a sandbox. |
| `--model <ref>` | tui, web, serve | Model as `provider/modelId`; overrides the saved default for this launch |
| `--storage <path>` | tui, web, serve | SQLite file (default `~/.neko/neko.sqlite`) |
| `--port <n>` | web, serve | Web UI port (default 8322) or gateway WebSocket port (default 8321; Windows picks a random port) |
| `--gateway-port <n>` | web | Gateway WebSocket port when the web UI starts the gateway |
| `--host <ip>` | web, serve | Web server address, or gateway WebSocket address (default `127.0.0.1`) |
| `--no-open` | web | Do not open the browser |
| `--socket-path <path>` | tui, web, serve | Unix socket path (POSIX only) |
| `--no-socket` | serve | Disable the Unix transport |
| `--theme <mode>` | tui | `light`, `dark` or `auto` (default) |
| `--lang <lang>` | tui | `zh` (default) or `en`; overrides `NEKO_LANG` and the saved choice |
| `--credentials <path>` | serve | Credentials file (default `~/.neko/credentials.json`) |
| `--config <dir>` | serve | Where the config file lookup starts |

### Config file

`neko.config.json` is looked up from the working directory upward to the filesystem root; if nothing is found, `~/.neko/neko.config.json` is used. It holds one JSON object; `$NAME` and `${NAME}` in string values are replaced from the environment, and a reference to an unset variable is an error.

```json
{
	"defaultModel": { "provider": "deepseek", "modelId": "deepseek-flash" },
	"thinkingLevel": "high",
	"webSearch": { "provider": "tavily" },
	"context": {
		"compaction": { "enabled": true, "triggerPercent": 80, "keepRecentTokens": 20000 },
		"pruning": { "enabled": false, "triggerPercent": 35, "keepRecent": 10 }
	}
}
```

| Key | Meaning |
| --- | --- |
| `defaultModel` | `{ provider, modelId }` for new sessions, below `--model` and the default saved in the UI |
| `thinkingLevel` | Thinking level for new sessions (default `high`, adjusted to what the model supports) |
| `storagePath` | SQLite file, same as `--storage` |
| `gateway.host`, `gateway.port`, `gateway.socketPath` | Gateway listen address, WebSocket port and Unix socket path (`socketPath: null` disables the Unix transport) |
| `skills.marketUrl` | Skill market base URL (default `https://skill.kirineko.tech`) |
| `webSearch.provider` | Initial search provider, `tavily` or `deepseek`; a choice saved in the UI wins |
| `context.compaction` | `enabled`, `triggerPercent` (1–99), `keepRecentTokens`; unset fields keep the native policy |
| `context.pruning` | `enabled`, `triggerPercent` (1–99), `keepRecent`, `minChars`, `minSavePercent`; off by default |
| `shell.path` | Git Bash `bash.exe` on Windows (a WSL `bash.exe` is rejected) |

### Data and environment

- `~/.neko/neko.sqlite` — sessions, messages, documents and settings, including the values saved from the UIs (default model, enabled providers, context settings, search provider).
- `~/.neko/credentials.json` — keys saved in the UI, in plain text for your user. Resetting a provider's key means removing it from the UI or this file.
- `~/.neko/gateway-server-id`, socket and port files — gateway discovery used by the UIs; replaced automatically. `~/.neko/update-check.json` caches the last update check.
- Environment variables: one per provider (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, …), `TAVILY_API_KEY` for web search, `NEKO_THEME` for the TUI theme, `NEKO_LANG` for the TUI language.

## Security

The assistant runs commands and edits files: use it in projects you trust, and remember the workspace is not a sandbox for its file access. The web UI and the gateway listen on loopback by default; phone pairing, opening a workspace in an editor and the mobile API are only available from the machine itself, and remote access is refused. Keys never leave the machine except to the provider they belong to. Exports and backups can contain code, prompts and keys — quit every neko process before copying `~/.neko/`, and treat the copy as sensitive.

## Upgrade

Finish your work, quit every neko UI and service, run `neko update`, then start again. On Windows, `neko update` prints the manual steps: quit neko and run `bun add --global neko-harness@latest`.

`/version` in the TUI and web **关于与更新** show the running version, check for updates and explain how to restart or reload. If the running version has no `neko update` command, reinstall with `bun add --global neko-harness`.

## Development

Source development needs Bun 1.4.2 (see `.bun-version`) and, on Windows, Git for Windows.

```bash
bun install --frozen-lockfile
bun run neko tui        # TUI from source (starts a gateway)
bun run neko web        # Web UI from source
bun run neko serve      # gateway only
```

| Command | What it does |
| --- | --- |
| `bun run build` | tsc build of every workspace package (the web package also runs vite) |
| `bun run test` | Bun test (`--conditions=neko-source --isolate`) |
| `bun run check` | biome check plus type checks for the root and the web client |
| `bun run check:write` | biome fixes plus the same type checks |
| `bun run build:release` | build the `dist/` release bundle |
| `bun run test:package` | pack into `artifacts/`, install in a temp directory and smoke test |

Layout:

- `packages/core` — session runtime, system prompt, tools and the provider catalog
- `packages/gateway` — Chord / WebSocket gateway and the mobile API
- `packages/tui`, `packages/web`, `packages/cli` — the two frontends and the `neko` command
- `apps/mobile` — Flutter app (beta)
- `openspec/` changes and specs, `docs/` protocol docs, `scripts/` build and release scripts

Conventions: Biome (tabs, double quotes, 120 columns); relative imports carry the `.ts` extension; TypeScript strict with `noUncheckedIndexedAccess`, `erasableSyntaxOnly` and `verbatimModuleSyntax`. `reference/` is read-only, `dist/` and `artifacts/` are not committed, and behaviour changes go through an `openspec/` change. Run `bun run check` and `bun run test` before handing work over.

## Documentation

- [AGENTS.md](AGENTS.md) — architecture, modules and development conventions
- [docs/README.zh-CN.md](docs/README.zh-CN.md) — this documentation in Chinese
- [docs/mobile-api-v1.md](docs/mobile-api-v1.md) — mobile JSON-RPC protocol
- [apps/mobile/README.md](apps/mobile/README.md) — building and releasing the Flutter app
- [.github/RELEASING.md](.github/RELEASING.md) — release process
- [openspec/](openspec/) — change proposals and specs

## License

[MIT](LICENSE). Built on the [Pi](https://github.com/earendil-works/pi) ecosystem.
