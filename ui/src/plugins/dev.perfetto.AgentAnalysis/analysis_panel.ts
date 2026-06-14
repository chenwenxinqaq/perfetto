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
import {Button, ButtonVariant} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Intent} from '../../widgets/common';
import {Select} from '../../widgets/select';
import {Spinner} from '../../widgets/spinner';
import type {AreaSelection} from '../../public/selection';
import type {Setting} from '../../public/settings';
import type {Conversation} from './conversation';
import type {LlmClient} from './llm_client';

export interface AnalysisPanelAttrs {
  readonly client: LlmClient;
  readonly selection: AreaSelection;
  readonly modelSetting: Setting<string>;
  readonly conversation: Conversation;
}

// Chat-style panel for the AI Analysis tab. The transcript lives in the
// Conversation object (per-trace), so it survives selection changes and panel
// remounts. Selecting a new area appends a chip rather than resetting.
export class AnalysisPanel implements m.ClassComponent<AnalysisPanelAttrs> {
  private md = markdownit();
  private models: string[] = [];
  private modelsLoaded = false;
  private autoScroll = true;

  oncreate({attrs}: m.CVnode<AnalysisPanelAttrs>): void {
    attrs.conversation.noteSelection(attrs.selection);
    this.loadModels(attrs);
  }

  onupdate({attrs}: m.CVnode<AnalysisPanelAttrs>): void {
    // Attach the (possibly new) selection as a pending chip, without wiping
    // the existing conversation.
    attrs.conversation.noteSelection(attrs.selection);
  }

  private async loadModels(attrs: AnalysisPanelAttrs): Promise<void> {
    if (this.modelsLoaded) return;
    this.modelsLoaded = true;
    try {
      const models = await attrs.client.listModels();
      this.models = models;
      const current = attrs.modelSetting.get();
      if (current !== '' && !this.models.includes(current)) {
        this.models = [current, ...this.models];
      }
      m.redraw();
    } catch {
      // Leave empty; fall back to the configured model.
    }
  }

  view({attrs}: m.CVnode<AnalysisPanelAttrs>): m.Children {
    const {conversation, modelSetting} = attrs;
    const model = modelSetting.get();
    const hasHistory = conversation.turns.length > 0;
    return m(
      '.pf-agent-analysis',
      this.renderHeader(conversation, modelSetting, model, hasHistory),
      this.renderTranscript(conversation),
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
      m(Button, {
        icon: 'add_comment',
        label: 'New chat',
        disabled: !hasHistory && conversation.pending.length === 0,
        onclick: () => {
          conversation.newChat();
          this.autoScroll = true;
        },
      }),
    );
  }

  private renderTranscript(conversation: Conversation): m.Children {
    return m(
      '.pf-agent-analysis__transcript',
      {
        onscroll: (e: Event) => {
          const el = e.target as HTMLElement;
          // Re-enable autoscroll only when the user is near the bottom.
          const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          this.autoScroll = nearBottom;
        },
        onupdate: (vnode: m.VnodeDOM) => {
          if (!this.autoScroll) return;
          const el = vnode.dom as HTMLElement;
          el.scrollTop = el.scrollHeight;
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
      chips?: ReadonlyArray<{id: string; label: string}>;
    },
    index: number,
  ): m.Children {
    const isUser = turn.role === 'user';
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
        turn.text === ''
          ? m(
              '.pf-agent-analysis__typing',
              m(Spinner, {easing: true}),
              m('span', 'Thinking…'),
            )
          : isUser
            ? m('.pf-agent-analysis__user-text', turn.text)
            : m('.pf-agent-analysis__md', m.trust(this.md.render(turn.text))),
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
