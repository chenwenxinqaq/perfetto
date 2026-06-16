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
- **Agentic SQL tool**: the model can call a read-only `run_perfetto_sql` tool
  to query the trace directly (via trace_processor) and verify hypotheses with
  real data instead of guessing. Tool calls are shown inline in the transcript
  ("🔧 SQL: … → N rows"). Only `SELECT` / `WITH` / `INCLUDE PERFETTO MODULE`
  statements are allowed; results are capped to keep them summarisable.
- **Diff / multi-trace tools**: when several traces are opened together via
  "Open traces for comparison (diff)" (each gets its own `machine_id`), the
  agent gets two extra tools:
  - `list_loaded_traces` — one row per loaded trace (machine id, process /
    slice counts, ts bounds). A single ordinary trace returns one row
    (`machine=0`).
  - `compare_slices_across_traces` — given a slice-name GLOB, returns per-trace
    count and total/avg/max duration so the agent can A/B the same operation
    across runs. If the user manually aligned the traces (timeline "Align"
    tool), each row also carries the applied `alignOffsetNs`.
- **Export tool**: `export_data_to_file` lets the agent download data it
  collected or compared to the user's machine (CSV for tables, JSON for nested
  data). Ask the agent to "export/save/download" a result and it writes a file
  via the browser's save dialog instead of only pasting the data into the chat.
- Selection summaries are restricted to the **selected tracks** (their
  trace_processor `track_id`s), so selecting different tracks yields different
  summaries.

## Settings

Configure these under **Settings → Agent Analysis** (the AI Analysis tab links
straight there if the token is missing):

| Setting | Default | Notes |
|---|---|---|
| API endpoint | `https://oneapi-comate.baidu-int.com/v1/chat/completions` | Any OpenAI-compatible endpoint. |
| API token | _(empty)_ | Your bearer token. Stored only in this browser's `localStorage`; never bundled into the build. |
| Model | `Claude Sonnet 4.6` | Default model; can be switched live in the panel. The model must support OpenAI function/tool calling for the SQL tool to work (e.g. gpt-5.5). |
| System prompt | _(built-in)_ | Optional override. |
| Prompt profiles | _(empty)_ | JSON describing domain prompt profiles (see below). |

> The default endpoint is an **internal** gateway (`*.baidu-int.com`). It only
> resolves from within the corporate network. If you deploy this publicly,
> users on the corporate network can use it as-is by filling in their token;
> off-network users must point the endpoint at a reachable OpenAI-compatible
> service.

## Prompt profiles (domain semantics, not hard-coded)

The agent doesn't natively understand domain-specific trace shapes (e.g. XPU
compute-card captures). Rather than hard-coding that knowledge, you supply it as
JSON in the **Prompt profiles** setting:

```json
{"profiles": [{"name": "...", "match": "SELECT count(*) FROM ... ", "prompt": "DOMAIN: ..."}]}
```

On trace load each profile's `match` query (a read-only count) is run; the first
one returning `> 0` has its `prompt` appended to the system prompt, so the agent
gets the right vocabulary automatically. The setting is empty by default.

A ready-made profile for XPU traces ships in
[`prompt_profiles.json`](./prompt_profiles.json) — copy its contents into the
**Prompt profiles** setting. It teaches the agent about XPU HW processes,
`SSE-Channel-*` queues, `cluster`/`sdnn` units, CPU dispatch processes, the
`args.device` link and the `xpu_device_map` view (published by the
`dev.perfetto.XpuWorkspace` plugin), plus how to measure channel overlap
correctly (interval sweep, not `sum(dur)/wall_time`).


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

