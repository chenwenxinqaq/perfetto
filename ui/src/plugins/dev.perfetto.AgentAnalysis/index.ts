// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import './styles.scss';

import m from 'mithril';
import {z} from 'zod';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {AreaSelection} from '../../public/selection';
import type {Setting} from '../../public/settings';
import type {Trace} from '../../public/trace';
import {Button, ButtonVariant} from '../../widgets/button';
import {Intent} from '../../widgets/common';
import {download} from '../../base/download_utils';
import {AnalysisPanel} from './analysis_panel';
import {Conversation} from './conversation';
import {ConversationHistoryStore} from './history_store';
import {LlmClient} from './llm_client';
import {pickProfilePrompt} from './profiles';
import {buildTools} from './tools';

const DEFAULT_SYSTEM_PROMPT = `You are an expert Perfetto trace analyst.
You can be asked about a framed region of the timeline OR about the whole trace
when nothing is selected — in the no-selection case, default to ALL loaded
traces. Given a selected time range and compact SQL summaries, explain what
happened, call out suspicious performance issues, and suggest concrete next
queries or UI checks. You can call the run_perfetto_sql tool to query the trace
directly with read-only PerfettoSQL — prefer verifying claims with real data
over guessing.
When the user loaded several traces together for comparison (via "Open traces
for comparison (diff)"), each trace has its own machine_id: call
list_loaded_traces first to see how many traces there are, and use
compare_slices_across_traces to diff the same operation between runs before
drilling in with run_perfetto_sql. For a per-kernel cost table broken down by
module and stage (e.g. FA/MOE -> flash_attention/reduce/dispatch/topk/... ->
each kernel's cost(us), with per-module/stage sums and percentages), use
kernel_cost_breakdown rather than writing SQL by hand. It defaults to the
user's CURRENT selection (their selected tracks AND time window), so for "the
selected channel/region" just call it with no track_ids/start_ts/end_ts. If the
kernels are flat under the track (no parent module slices — the usual XPU
case), pass a "groups" list (kernel-name GLOB -> module/stage rules) to classify
them; otherwise it reads module/stage from slice nesting. Keep the returned rows
in their given EXECUTION-time order — never re-sort the table by cost. When the
user asks to save, export, or download data you collected or compared, call
export_data_to_file with the full content (CSV for tables, JSON for nested
data) instead of only pasting it into the chat. Be concise and avoid inventing
facts not supported by the data.`;

export default class AgentAnalysisPlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.AgentAnalysis';
  static readonly description =
    'Adds an AI Analysis tab for selected timeline ranges.';

  static endpointSetting: Setting<string>;
  static tokenSetting: Setting<string>;
  static modelSetting: Setting<string>;
  static promptSetting: Setting<string>;
  static profilesSetting: Setting<string>;

  static onActivate(app: App): void {
    AgentAnalysisPlugin.endpointSetting = app.settings.register({
      id: `${AgentAnalysisPlugin.id}#Endpoint`,
      name: 'Agent Analysis API endpoint',
      description:
        'OpenAI-compatible chat completions endpoint. Defaults to the Baidu ' +
        'OneAPI gateway (https://oneapi-comate.baidu-int.com/v1/chat/completions).',
      schema: z.string(),
      defaultValue: 'https://oneapi-comate.baidu-int.com/v1/chat/completions',
    });

    AgentAnalysisPlugin.tokenSetting = app.settings.register({
      id: `${AgentAnalysisPlugin.id}#Token`,
      name: 'Agent Analysis API token',
      description: 'Bearer token for the configured LLM endpoint.',
      schema: z.string(),
      defaultValue: '',
    });

    AgentAnalysisPlugin.modelSetting = app.settings.register({
      id: `${AgentAnalysisPlugin.id}#Model`,
      name: 'Agent Analysis model',
      description:
        'Default model. Can also be switched live from the AI Analysis panel.',
      schema: z.string(),
      defaultValue: 'Claude Sonnet 4.6',
    });

    AgentAnalysisPlugin.promptSetting = app.settings.register({
      id: `${AgentAnalysisPlugin.id}#SystemPrompt`,
      name: 'Agent Analysis system prompt',
      description: 'System prompt used by the AI trace analyst.',
      schema: z.string(),
      defaultValue: DEFAULT_SYSTEM_PROMPT,
    });

    AgentAnalysisPlugin.profilesSetting = app.settings.register({
      id: `${AgentAnalysisPlugin.id}#PromptProfiles`,
      name: 'Agent Analysis prompt profiles',
      description:
        'JSON describing domain prompt profiles: ' +
        '{"profiles":[{"name","match"(a count SQL >0 to apply),"prompt"}]}. ' +
        'The first profile whose match query returns >0 has its prompt ' +
        'appended to the system prompt. See the plugin README / ' +
        'prompt_profiles.json for an XPU example. Empty disables profiles.',
      schema: z.string(),
      defaultValue: '',
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    // Cross-trace alignment shifts a machine's tracks at RENDER time by a
    // constant ns offset, so an aligned trace's area selection is in DISPLAY
    // coordinates (realTs + offset) while trace_processor stores the real ts.
    // This resolves the offset for the tracks in an area (0n if unaligned) so
    // selection summaries and the kernel tool can map the window back to real
    // ts — otherwise an aligned trace's tracks return 0 rows.
    const alignOffsetForArea = (tracks: AreaSelection['tracks']): bigint => {
      if (!trace.timeline.hasTimeAlignment) return 0n;
      for (const t of tracks) {
        const tags = t.tags;
        let machine: number | undefined;
        if (tags?.utid !== undefined) {
          machine = trace.timeline.machineForUtid(tags.utid);
        } else if (tags?.upid !== undefined) {
          machine = trace.timeline.machineForUpid(tags.upid);
        }
        if (machine !== undefined) {
          return trace.timeline.machineTimeOffset(machine) ?? 0n;
        }
      }
      return 0n;
    };

    // Domain prompt appended once we've detected which profile (if any) the
    // trace matches; resolved asynchronously below.
    let profilePrompt = '';
    const makeClient = () =>
      new LlmClient({
        endpoint: AgentAnalysisPlugin.endpointSetting.get(),
        apiKey: AgentAnalysisPlugin.tokenSetting.get(),
        systemPrompt:
          AgentAnalysisPlugin.promptSetting.get() +
          (profilePrompt !== '' ? `\n\n${profilePrompt}` : ''),
      });

    // One conversation per trace, so history survives selection changes and
    // panel remounts. Saved conversations are keyed by the trace uuid.
    const conversation = new Conversation({
      engine: trace.engine,
      client: makeClient(),
      traceStart: trace.traceInfo.start,
      resolveTrackName: (uri) =>
        trace.workspaces.currentWorkspace.flatTracks.find((t) => t.uri === uri)
          ?.name ?? uri,
      store: new ConversationHistoryStore(trace.traceInfo.uuid),
      // Pass the timeline as the alignment provider so the diff tools can
      // report any manual cross-trace time-alignment offsets the user applied.
      // The export tool downloads collected/compared data to the user's machine.
      tools: buildTools(
        trace.engine,
        {
          machineTimeOffset: (m) => trace.timeline.machineTimeOffset(m),
        },
        (a) =>
          // No filePicker: the native save dialog (showSaveFilePicker) needs a
          // user gesture, but this fires from the async agent loop (no click),
          // so it would throw and silently no-op. The anchor-download fallback
          // works without a gesture and reliably saves the file.
          download({
            content: a.content,
            fileName: a.fileName,
            mimeType: a.mimeType,
          }),
        // Default tools (e.g. kernel_cost_breakdown) to the user's CURRENT area
        // selection: its time window and the trace_processor track_ids behind
        // the selected UI tracks (one UI track can map to several sql track_ids;
        // non-slice tracks contribute none). Read fresh each call.
        () => {
          const sel = trace.selection.selection;
          if (sel.kind !== 'area') return undefined;
          const trackIds: number[] = [];
          for (const t of sel.tracks) {
            const rootTable = t.renderer?.rootTableName;
            if (rootTable !== undefined && rootTable !== 'slice') continue;
            for (const id of t.tags?.trackIds ?? []) trackIds.push(id);
          }
          // Undo the render-time alignment shift so the queried window matches
          // the real slice ts (an aligned trace would otherwise return 0 rows).
          const offset = alignOffsetForArea(sel.tracks);
          return {
            trackIds,
            startTs: Number(sel.start - offset),
            endTs: Number(sel.end - offset),
          };
        },
      ),
      alignOffsetForArea: (area) => alignOffsetForArea(area.tracks),
    });
    trace.trash.defer(() => conversation.dispose());

    // Detect the matching domain profile once the trace is queryable, then
    // rebuild the client so its system prompt includes the domain semantics.
    trace.onTraceReady.addListener(async () => {
      profilePrompt = await pickProfilePrompt(
        trace.engine,
        AgentAnalysisPlugin.profilesSetting.get(),
      );
      if (profilePrompt !== '') conversation.refreshClient(makeClient());
    });

    // Renders either the missing-token prompt or the chat panel. `selection`
    // is undefined when hosted as a standalone page (sidebar entry).
    const renderContent = (selection?: AreaSelection): m.Children => {
      if (AgentAnalysisPlugin.tokenSetting.get() === '') {
        return m(
          '.pf-agent-analysis.pf-agent-analysis--missing-token',
          m('h3', 'AI Analysis'),
          m(
            'p',
            'Set the Agent Analysis API token in settings before sending ' +
              'selected trace summaries to an external LLM.',
          ),
          m(Button, {
            label: 'Open settings',
            icon: 'settings',
            intent: Intent.Primary,
            variant: ButtonVariant.Filled,
            onclick: () => {
              window.location.hash = '#!/settings';
            },
          }),
        );
      }
      // Pick up live edits to endpoint/token/prompt.
      conversation.refreshClient(makeClient());
      return m(AnalysisPanel, {
        client: conversation.client,
        selection,
        modelSetting: AgentAnalysisPlugin.modelSetting,
        conversation,
      });
    };

    // A persistent tab in the details panel. Unlike an area-selection tab, it
    // stays put when the selection changes or is cleared, so the conversation
    // window is never torn down by clicking elsewhere. It reads the CURRENT
    // selection itself: a framed area is attached as a chip; with nothing
    // selected the agent simply defaults to the whole trace (all loaded
    // traces). This is the primary, always-available entry point.
    const TAB_URI = 'dev.perfetto.AgentAnalysis#tab';
    trace.tabs.registerTab({
      uri: TAB_URI,
      isEphemeral: false,
      content: {
        getTitle: () => 'AI Analysis',
        render: () => {
          const sel = trace.selection.selection;
          const area = sel.kind === 'area' ? sel : undefined;
          return renderContent(area);
        },
      },
    });
    trace.tabs.addDefaultTab(TAB_URI);

    // Standalone page reachable even with nothing selected (sidebar entry).
    trace.pages.registerPage({
      route: '/agent_analysis',
      render: () => m('.pf-agent-analysis-page', renderContent(undefined)),
    });

    // Sidebar shortcut to the standalone page.
    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: 'AI Analysis',
      href: '#!/agent_analysis',
      icon: 'smart_toy',
      sortOrder: 10,
    });
  }
}
