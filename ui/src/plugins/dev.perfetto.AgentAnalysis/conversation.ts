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

// Holds the AI Analysis conversation state for a single trace. Lives outside
// the (transient) area-selection panel so that history survives selection
// changes and panel unmount/remount.

import m from 'mithril';
import {Duration} from '../../base/time';
import type {duration, time} from '../../base/time';
import type {AreaSelection} from '../../public/selection';
import type {Engine} from '../../trace_processor/engine';
import {buildSelectionContext} from './context_builder';
import type {LlmClient, LlmMessage} from './llm_client';

// A trace region the user attached to their next message, shown as a chip.
export interface SelectionChip {
  readonly id: string; // Stable id (start-end-tracks) used for dedup.
  readonly label: string; // Human readable, e.g. "CPU 0 [1.2s–3.4s]".
  readonly area: AreaSelection;
}

// One message in the visible transcript.
export interface Turn {
  readonly role: 'user' | 'assistant';
  text: string; // Display text (also streamed into for assistant turns).
  readonly chips?: ReadonlyArray<SelectionChip>; // Attached to user turns.
  llmContent?: string; // What is actually sent to the LLM (may include SQL).
  isError?: boolean;
}

export interface ConversationDeps {
  readonly engine: Engine;
  client: LlmClient;
  readonly traceStart: time;
  readonly resolveTrackName: (uri: string) => string;
}

export class Conversation {
  readonly turns: Turn[] = [];
  pending: SelectionChip[] = [];
  input = '';
  isLoading = false;
  private abort?: AbortController;
  private lastNotedId?: string;

  constructor(private readonly deps: ConversationDeps) {}

  // Refreshes the LLM client (e.g. after the user edits endpoint/token in
  // settings). Does not interrupt an in-flight stream.
  refreshClient(client: LlmClient): void {
    this.deps.client = client;
  }

  get client(): LlmClient {
    return this.deps.client;
  }

  // Records the currently-selected area as a pending chip (deduped). Called by
  // the panel whenever it renders with a (possibly new) area selection. Does
  // NOT touch the transcript, so selecting no longer wipes the conversation.
  noteSelection(sel: AreaSelection): void {
    const id = `${sel.start}-${sel.end}-${sel.trackUris.join(',')}`;
    if (this.lastNotedId === id) return;
    this.lastNotedId = id;
    if (this.pending.some((c) => c.id === id)) return;
    this.pending.push({id, label: this.labelFor(sel), area: sel});
    m.redraw();
  }

  removePending(id: string): void {
    this.pending = this.pending.filter((c) => c.id !== id);
  }

  newChat(): void {
    this.abort?.abort();
    this.turns.length = 0;
    this.pending = [];
    this.input = '';
    this.isLoading = false;
    this.lastNotedId = undefined;
  }

  dispose(): void {
    this.abort?.abort();
  }

  // Sends the user's current input (plus any attached selection chips) and
  // streams the assistant reply into a new transcript turn.
  async send(model: string): Promise<void> {
    const userText = this.input.trim();
    const chips = this.pending;
    if (userText === '' && chips.length === 0) return;
    if (this.isLoading) return;

    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.isLoading = true;
    this.input = '';
    this.pending = [];

    // Build the LLM-facing content: compact summaries for each attached
    // selection, followed by the user's question.
    let llmContent = '';
    for (const chip of chips) {
      try {
        const ctx = await buildSelectionContext(this.deps.engine, chip.area);
        llmContent += `Selected region "${chip.label}":\n${ctx}\n\n`;
      } catch {
        // Skip a region whose context could not be built.
      }
    }
    llmContent +=
      userText !== '' ? userText : 'Analyze the selected region(s).';

    this.turns.push({
      role: 'user',
      text: userText !== '' ? userText : 'Analyze the selected region(s).',
      chips,
      llmContent,
    });
    const assistant: Turn = {role: 'assistant', text: ''};
    this.turns.push(assistant);
    m.redraw();

    // Assemble the full multi-turn history for the API.
    const history: LlmMessage[] = this.turns
      .slice(0, -1) // exclude the empty assistant turn we just pushed
      .map((t) => ({
        role: t.role,
        content: t.role === 'user' ? t.llmContent ?? t.text : t.text,
      }));

    try {
      for await (const chunk of this.deps.client.send(history, model, signal)) {
        assistant.text += chunk.text;
        m.redraw();
      }
      if (assistant.text === '') {
        assistant.text = '(no response)';
      }
    } catch (e: unknown) {
      if ((e as {name?: string}).name !== 'AbortError') {
        assistant.text = `Error: ${String(e)}`;
        assistant.isError = true;
      }
    } finally {
      this.isLoading = false;
      m.redraw();
    }
  }

  private labelFor(sel: AreaSelection): string {
    const dur = sel.end - sel.start;
    const startOff = (sel.start - this.deps.traceStart) as duration;
    const endOff = (sel.end - this.deps.traceStart) as duration;
    const range = `${Duration.humanise(startOff)}–${Duration.humanise(endOff)}`;
    const name =
      sel.trackUris.length === 1
        ? this.deps.resolveTrackName(sel.trackUris[0])
        : `${sel.trackUris.length} tracks`;
    return `${name} [${range}] · ${Duration.humanise(dur)}`;
  }
}
