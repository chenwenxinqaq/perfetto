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

import m from 'mithril';
import markdownit from 'markdown-it';
import {download} from '../../base/download_utils';
import {Button, ButtonVariant} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Intent} from '../../widgets/common';
import {Popup, PopupPosition} from '../../widgets/popup';
import {Select} from '../../widgets/select';
import {Spinner} from '../../widgets/spinner';
import type {AreaSelection} from '../../public/selection';
import type {Setting} from '../../public/settings';
import type {Conversation} from './conversation';
import type {AgentLogStore, LogRound} from './agent_log';
import type {LlmClient} from './llm_client';

export interface AnalysisPanelAttrs {
  readonly client: LlmClient;
  // The current area selection, if the panel is hosted in the selection tab.
  // Undefined when opened as a standalone page (sidebar / no selection).
  readonly selection?: AreaSelection;
  readonly modelSetting: Setting<string>;
  readonly conversation: Conversation;
  // The agent's per-round debug log (request / tool calls / timings).
  readonly log: AgentLogStore;
}

// Known model ids on the Baidu OneAPI gateway, used to populate the dropdown
// when /v1/models can't be fetched (network/CORS) or omits some entries.
const FALLBACK_MODELS = [
  'Claude Sonnet 4.6',
  'Claude Opus 4.7',
  'Claude Opus 4.6',
  'Claude Haiku 4.5',
  'gpt-5.5',
  'gpt-5.4',
];

// Formats a past timestamp as a compact relative string ("5 min ago").
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// Chat-style panel for the AI Analysis tab. The transcript lives in the
// Conversation object (per-trace), so it survives selection changes and panel
// remounts. Selecting a new area appends a chip rather than resetting.
export class AnalysisPanel implements m.ClassComponent<AnalysisPanelAttrs> {
  private md = markdownit();
  private models: string[] = [];
  private modelsLoaded = false;
  private autoScroll = true;
  // When true, the panel shows the agent debug log instead of the transcript.
  private showLog = false;
  // Memoised markdown render per assistant turn. Re-rendering the full
  // markdown on every streaming token reflows the whole transcript and makes
  // scrolling janky, so we cache the HTML and only re-parse when the text grew
  // and at most every RENDER_THROTTLE_MS while streaming.
  private mdCache = new Map<number, {text: string; html: string; at: number}>();
  private static readonly RENDER_THROTTLE_MS = 80;

  // Returns rendered markdown HTML for an assistant turn, throttled while the
  // text is still streaming so we don't re-parse on every token.
  private renderMarkdown(index: number, text: string): string {
    const cached = this.mdCache.get(index);
    if (cached !== undefined && cached.text === text) {
      return cached.html; // Unchanged (e.g. a completed turn) — reuse.
    }
    const now = Date.now();
    if (
      cached !== undefined &&
      now - cached.at < AnalysisPanel.RENDER_THROTTLE_MS &&
      text.startsWith(cached.text)
    ) {
      // Still streaming and we rendered very recently: reuse the slightly
      // stale HTML this frame; the next frame past the throttle will catch up.
      return cached.html;
    }
    const html = this.md.render(text);
    this.mdCache.set(index, {text, html, at: now});
    return html;
  }

  oncreate({attrs}: m.CVnode<AnalysisPanelAttrs>): void {
    if (attrs.selection !== undefined) {
      attrs.conversation.noteSelection(attrs.selection);
    }
    this.loadModels(attrs);
  }

  onupdate({attrs}: m.CVnode<AnalysisPanelAttrs>): void {
    // Attach the (possibly new) selection as a pending chip, without wiping
    // the existing conversation. No-op on the standalone page (no selection).
    if (attrs.selection !== undefined) {
      attrs.conversation.noteSelection(attrs.selection);
    }
  }

  private async loadModels(attrs: AnalysisPanelAttrs): Promise<void> {
    if (this.modelsLoaded) return;
    this.modelsLoaded = true;
    try {
      const models = await attrs.client.listModels();
      // Merge the fetched list with the known fallback ids so the dropdown is
      // always populated even if the gateway omits some (and de-dup).
      this.models = [...new Set([...models, ...FALLBACK_MODELS])].sort((a, b) =>
        a.localeCompare(b),
      );
      const current = attrs.modelSetting.get();
      if (current !== '' && !this.models.includes(current)) {
        this.models = [current, ...this.models];
      }
      m.redraw();
    } catch {
      // Fetch failed (network / CORS). Fall back to the known list so the user
      // can still pick a model, and allow a retry on the next mount.
      this.modelsLoaded = false;
      const current = attrs.modelSetting.get();
      this.models = [...new Set([current, ...FALLBACK_MODELS])]
        .filter((m) => m !== '')
        .sort((a, b) => a.localeCompare(b));
      m.redraw();
    }
  }

  view({attrs}: m.CVnode<AnalysisPanelAttrs>): m.Children {
    const {conversation, modelSetting} = attrs;
    const model = modelSetting.get();
    const hasHistory = conversation.turns.length > 0;
    return m(
      '.pf-agent-analysis',
      this.renderHeader(conversation, modelSetting, model, hasHistory),
      this.showLog
        ? this.renderLog(attrs.log)
        : this.renderTranscript(conversation),
      this.renderComposer(conversation, model),
    );
  }

  private renderHeader(
    conversation: Conversation,
    modelSetting: Setting<string>,
    model: string,
    hasHistory: boolean,
  ): m.Children {
    const options = this.models.length > 0 ? this.models : [model];
    return m(
      '.pf-agent-analysis__header',
      m(
        '.pf-agent-analysis__title',
        m(Icon, {icon: 'smart_toy'}),
        m('span', 'AI Analysis'),
      ),
      m('.pf-agent-analysis__spacer'),
      m(
        '.pf-agent-analysis__model',
        m('span.pf-agent-analysis__model-label', 'Model'),
        m(
          Select,
          {
            className: 'pf-agent-analysis__model-select',
            disabled: conversation.isLoading,
            onchange: (e: Event) => {
              modelSetting.set((e.target as HTMLSelectElement).value);
            },
          },
          options.map((id) =>
            m('option', {value: id, selected: id === model}, id),
          ),
        ),
        !this.modelsLoaded && m(Spinner, {easing: true}),
      ),
      this.renderHistoryMenu(conversation),
      // Toggle between the chat transcript and the agent debug log.
      m(Button, {
        icon: 'bug_report',
        title: this.showLog ? 'Back to chat' : 'Agent log (debug)',
        active: this.showLog,
        onclick: () => {
          this.showLog = !this.showLog;
        },
      }),
      m(Button, {
        icon: 'add_comment',
        label: 'New chat',
        disabled: !hasHistory && conversation.pending.length === 0,
        onclick: () => {
          conversation.newChat();
          this.mdCache.clear();
          this.autoScroll = true;
        },
      }),
    );
  }

  private renderHistoryMenu(conversation: Conversation): m.Children {
    const saved = conversation.history();
    return m(
      Popup,
      {
        position: PopupPosition.BottomEnd,
        trigger: m(Button, {
          icon: 'history',
          title: 'Conversation history',
        }),
      },
      m(
        '.pf-agent-analysis__history',
        saved.length === 0
          ? m(
              '.pf-agent-analysis__history-empty',
              'No saved conversations yet.',
            )
          : saved.map((c) =>
              m(
                '.pf-agent-analysis__history-item' +
                  (c.id === conversation.id
                    ? '.pf-agent-analysis__history-item--current'
                    : ''),
                {key: c.id},
                // Only the text area carries the dismiss class, so restoring a
                // conversation closes the popup but deleting keeps it open.
                m(
                  '.pf-agent-analysis__history-text.' +
                    Popup.DISMISS_POPUP_GROUP_CLASS,
                  {
                    onclick: () => {
                      conversation.switchTo(c.id);
                      this.mdCache.clear();
                      this.autoScroll = true;
                    },
                  },
                  m('.pf-agent-analysis__history-title', c.title),
                  m('.pf-agent-analysis__history-time', timeAgo(c.updatedAt)),
                ),
                m(Icon, {
                  icon: 'delete',
                  className: 'pf-agent-analysis__history-delete',
                  onclick: () => conversation.deleteSaved(c.id),
                }),
              ),
            ),
      ),
    );
  }

  // Renders the agent debug log: the last few rounds with the request sent,
  // each tool call (args + result preview + timing) and the final answer, so
  // the agent loop is inspectable instead of a black box. Includes a button to
  // download the whole log as JSON.
  private renderLog(log: AgentLogStore): m.Children {
    const rounds = log.list();
    return m(
      '.pf-agent-analysis__transcript.pf-agent-analysis__log',
      m(
        '.pf-agent-analysis__log-toolbar',
        m('span.pf-agent-analysis__log-count', `${rounds.length} round(s)`),
        m('.pf-agent-analysis__spacer'),
        m(Button, {
          icon: 'download',
          label: 'Export JSON',
          disabled: rounds.length === 0,
          onclick: () =>
            download({
              content: JSON.stringify(rounds, null, 2),
              fileName: `agent_log_${Date.now()}.json`,
              mimeType: 'application/json',
            }),
        }),
        m(Button, {
          icon: 'delete',
          label: 'Clear',
          disabled: rounds.length === 0,
          onclick: () => log.clear(),
        }),
      ),
      rounds.length === 0
        ? m(
            '.pf-agent-analysis__empty',
            m('p', 'No agent activity logged yet.'),
            m(
              'p.pf-agent-analysis__hint',
              'Ask a question; each round (request, tool calls, timings) is ' +
                'recorded here for inspection.',
            ),
          )
        : rounds.map((r) => this.renderLogRound(r)),
    );
  }

  private renderLogRound(r: LogRound): m.Children {
    const when = new Date(r.ts).toLocaleTimeString();
    const errored = r.error !== undefined && r.error !== 'aborted';
    return m(
      'details.pf-agent-analysis__log-round' +
        (errored ? '.pf-agent-analysis__log-round--error' : ''),
      {key: r.id},
      m(
        'summary.pf-agent-analysis__log-summary',
        m('span.pf-agent-analysis__log-time', when),
        m('span.pf-agent-analysis__log-model', r.model),
        m(
          'span.pf-agent-analysis__log-meta',
          `${r.toolCalls.length} tool call(s) · ${r.rounds} round(s) · ` +
            `${(r.durationMs / 1000).toFixed(1)}s`,
        ),
        r.error !== undefined &&
          m('span.pf-agent-analysis__log-badge', r.error),
      ),
      m(
        '.pf-agent-analysis__log-body',
        m('.pf-agent-analysis__log-section-title', 'User message'),
        m('pre.pf-agent-analysis__log-pre', r.userText),
        m('.pf-agent-analysis__log-section-title', 'System prompt'),
        m('pre.pf-agent-analysis__log-pre', r.systemPrompt),
        m('.pf-agent-analysis__log-section-title', 'Tool calls'),
        r.toolCalls.length === 0
          ? m('.pf-agent-analysis__log-none', '(none)')
          : r.toolCalls.map((tc, i) =>
              m(
                '.pf-agent-analysis__log-tool' +
                  (tc.isError ? '.pf-agent-analysis__log-tool--error' : ''),
                {key: i},
                m(
                  '.pf-agent-analysis__log-tool-head',
                  m('code', tc.name),
                  m(
                    'span.pf-agent-analysis__log-tool-time',
                    `${tc.durationMs}ms`,
                  ),
                ),
                m('pre.pf-agent-analysis__log-pre', `args: ${tc.arguments}`),
                m(
                  'pre.pf-agent-analysis__log-pre',
                  `→ ${tc.resultSummary}\n${tc.resultPreview}`,
                ),
              ),
            ),
        m('.pf-agent-analysis__log-section-title', 'Final answer'),
        m(
          'pre.pf-agent-analysis__log-pre',
          r.responseText === '' ? '(empty)' : r.responseText,
        ),
      ),
    );
  }

  private renderTranscript(conversation: Conversation): m.Children {
    return m(
      '.pf-agent-analysis__transcript',
      {
        onscroll: (e: Event) => {
          const el = e.target as HTMLElement;
          // Re-enable autoscroll only when the user is near the bottom. Any
          // meaningful upward scroll disables it so we don't yank the view back
          // down on the next streamed token.
          const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          this.autoScroll = nearBottom;
        },
        onupdate: (vnode: m.VnodeDOM) => {
          if (!this.autoScroll) return;
          const el = vnode.dom as HTMLElement;
          // Only nudge if we're not already at the bottom, and jump straight
          // there (no smooth-scroll: a per-token animation fights itself and
          // feels janky). The user scrolling up clears autoScroll above.
          if (el.scrollTop + el.clientHeight < el.scrollHeight) {
            el.scrollTop = el.scrollHeight;
          }
        },
      },
      conversation.turns.length === 0
        ? m(
            '.pf-agent-analysis__empty',
            m('p', 'Select a timeline region, then ask a question.'),
            m(
              'p.pf-agent-analysis__hint',
              'Selected regions are attached as chips below — they are only ' +
                'sent to the external LLM when you press Send.',
            ),
          )
        : conversation.turns.map((turn, i) => this.renderTurn(turn, i)),
    );
  }

  private renderTurn(
    turn: {
      role: 'user' | 'assistant';
      text: string;
      isError?: boolean;
      toolNotes?: string[];
      chips?: ReadonlyArray<{id: string; label: string}>;
    },
    index: number,
  ): m.Children {
    const isUser = turn.role === 'user';
    const hasToolNotes = (turn.toolNotes?.length ?? 0) > 0;
    return m(
      `.pf-agent-analysis__msg.pf-agent-analysis__msg--${turn.role}`,
      {key: index},
      m(
        '.pf-agent-analysis__avatar',
        m(Icon, {icon: isUser ? 'person' : 'smart_toy'}),
      ),
      m(
        '.pf-agent-analysis__bubble' +
          (turn.isError ? '.pf-agent-analysis__bubble--error' : ''),
        turn.chips &&
          turn.chips.length > 0 &&
          m(
            '.pf-agent-analysis__msg-chips',
            turn.chips.map((c) =>
              m(
                'span.pf-agent-analysis__chip.pf-agent-analysis__chip--static',
                m(Icon, {icon: 'crop'}),
                c.label,
              ),
            ),
          ),
        // Tools the agent ran while producing this answer.
        hasToolNotes &&
          m(
            '.pf-agent-analysis__tools',
            turn.toolNotes!.map((note) =>
              m(
                '.pf-agent-analysis__tool',
                m(Icon, {icon: 'build'}),
                m('span.pf-agent-analysis__tool-text', note),
              ),
            ),
          ),
        turn.text === ''
          ? hasToolNotes
            ? m(
                '.pf-agent-analysis__typing',
                m(Spinner, {easing: true}),
                m('span', 'Working…'),
              )
            : m(
                '.pf-agent-analysis__typing',
                m(Spinner, {easing: true}),
                m('span', 'Thinking…'),
              )
          : isUser
            ? m('.pf-agent-analysis__user-text', turn.text)
            : m(
                '.pf-agent-analysis__md',
                m.trust(this.renderMarkdown(index, turn.text)),
              ),
      ),
    );
  }

  private renderComposer(
    conversation: Conversation,
    model: string,
  ): m.Children {
    const canSend =
      !conversation.isLoading &&
      (conversation.input.trim() !== '' || conversation.pending.length > 0);
    return m(
      '.pf-agent-analysis__composer',
      conversation.pending.length > 0 &&
        m(
          '.pf-agent-analysis__pending-chips',
          conversation.pending.map((c) =>
            m(
              'span.pf-agent-analysis__chip',
              {key: c.id},
              m(Icon, {icon: 'crop'}),
              m('span.pf-agent-analysis__chip-label', c.label),
              m(Icon, {
                icon: 'close',
                className: 'pf-agent-analysis__chip-remove',
                onclick: () => conversation.removePending(c.id),
              }),
            ),
          ),
        ),
      m(
        '.pf-agent-analysis__input-row',
        m('textarea.pf-agent-analysis__input', {
          rows: 1,
          placeholder:
            conversation.pending.length > 0
              ? 'Ask about the selected region(s)…'
              : 'Ask a question about this trace…',
          value: conversation.input,
          disabled: conversation.isLoading,
          oninput: (e: Event) => {
            conversation.input = (e.target as HTMLTextAreaElement).value;
          },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) {
                this.autoScroll = true;
                conversation.send(model);
              }
            }
          },
        }),
        m(Button, {
          icon: 'send',
          title: 'Send (Enter)',
          disabled: !canSend,
          intent: Intent.Primary,
          variant: ButtonVariant.Filled,
          onclick: () => {
            this.autoScroll = true;
            conversation.send(model);
          },
        }),
      ),
    );
  }
}
