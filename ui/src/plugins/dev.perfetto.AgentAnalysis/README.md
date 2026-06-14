# AI Analysis plugin (`dev.perfetto.AgentAnalysis`)

Adds an **AI Analysis** tab to the timeline's area-selection drawer. Select a
region of the timeline, attach it to a chat, and ask an LLM questions about it.
The plugin sends only a compact, aggregated SQL summary of the selection (top
slices, CPU usage by process, time range) — never the raw trace — and only when
you press **Send**.

## How it works

- Pure client-side: traces are parsed locally in the browser (WASM). The only
  outbound traffic is the chat request, sent **directly from your browser** to
  the configured LLM endpoint.
- OpenAI-compatible: works with any `/v1/chat/completions` streaming endpoint
  (OpenAI, a OneAPI-style gateway, etc.). The model list is fetched from the
  matching `/v1/models` endpoint and shown in a dropdown.
- Multi-turn chat: conversation history is kept per-trace and survives selection
  changes. Selecting a new region attaches it as a chip rather than resetting.

## Settings

Configure these under **Settings → Agent Analysis** (the AI Analysis tab links
straight there if the token is missing):

| Setting | Default | Notes |
|---|---|---|
| API endpoint | `https://oneapi-comate.baidu-int.com/v1/chat/completions` | Any OpenAI-compatible endpoint. |
| API token | _(empty)_ | Your bearer token. Stored only in this browser's `localStorage`; never bundled into the build. |
| Model | `Claude Sonnet 4.6` | Default model; can be switched live in the panel. |
| System prompt | _(built-in)_ | Optional override. |

> The default endpoint is an **internal** gateway (`*.baidu-int.com`). It only
> resolves from within the corporate network. If you deploy this publicly,
> users on the corporate network can use it as-is by filling in their token;
> off-network users must point the endpoint at a reachable OpenAI-compatible
> service.

## Deploying to GitHub Pages

This plugin is enabled by default (see `ui/src/core/embedder/default_plugins.ts`),
so a freshly deployed UI shows the **AI Analysis** tab out of the box — each
user just fills in their own token under Settings.

A ready-to-use workflow lives at `.github/workflows/deploy-ui.yml`. To turn it
on:

1. In the repo, go to **Settings → Pages** and set **Source = GitHub Actions**.
2. Push to `main` (or trigger the workflow manually from the **Actions** tab).
   The workflow builds the full UI — including the trace_processor WASM — on a
   GitHub-hosted runner and publishes `out/ui/ui/dist` to Pages.
3. Share the resulting URL. First-time users open **Settings → Agent Analysis**,
   paste their LLM token, then select a timeline region and start asking.

Notes:

- The WASM toolchain is fetched from `*.googlesource.com`, which is reachable
  from GitHub-hosted runners (but may be blocked on a corporate network — that's
  why the build runs in CI rather than locally).
- A user/organization site served from the root path (`<name>.github.io`) needs
  no extra configuration. A project site served from a sub-path
  (`<name>.github.io/<repo>/`) works too, but the service worker (offline cache)
  is disabled on non-root paths.
- No secrets are required by the workflow, and no token is ever baked into the
  build — tokens live only in each user's browser.

