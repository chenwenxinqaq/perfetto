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
import type {
  ConversationHistoryStore,
  SavedConversation,
} from './history_store';
import type {AgentLogStore} from './agent_log';
import type {LlmClient, LlmMessage} from './llm_client';
import type {Tool} from './tools';

// Cap on agentic tool-call rounds per user message, to bound cost / loops.
const MAX_TOOL_ROUNDS = 30;

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
  chips?: ReadonlyArray<{readonly id: string; readonly label: string}>;
  llmContent?: string; // What is actually sent to the LLM (may include SQL).
  // Tool calls the assistant ran while producing this turn (for display).
  toolNotes?: string[];
  isError?: boolean;
}

export interface ConversationDeps {
  readonly engine: Engine;
  client: LlmClient;
  readonly traceStart: time;
  readonly resolveTrackName: (uri: string) => string;
  readonly store: ConversationHistoryStore;
  // The tools the agent may call (e.g. run_perfetto_sql).
  readonly tools: ReadonlyArray<Tool>;
  // Records each send() round (request, tool calls, timings) for inspection.
  readonly log: AgentLogStore;
  // Render-time cross-trace alignment offset (ns) applied to an area's tracks,
  // so selection summaries can convert the display window back to real ts.
  // Returns 0n when the selection's trace isn't aligned. Optional (single-trace
  // sessions don't need it).
  readonly alignOffsetForArea?: (area: AreaSelection) => bigint;
}

let convSeq = 0;
function newConversationId(): string {
  return `c-${Date.now().toString(36)}-${(convSeq++).toString(36)}`;
}

export class Conversation {
  readonly turns: Turn[] = [];
  pending: SelectionChip[] = [];
  input = '';
  isLoading = false;
  id = newConversationId();
  private createdAt = Date.now();
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

  // A short title derived from the first user message (for the history list).
  get title(): string {
    const firstUser = this.turns.find((t) => t.role === 'user');
    const raw = firstUser?.text.trim() ?? '';
    if (raw === '') return 'New chat';
    return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
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
    // Start a fresh conversation id/timestamp; the previous one is already
    // persisted (send() upserts after every turn).
    this.id = newConversationId();
    this.createdAt = Date.now();
  }

  dispose(): void {
    this.abort?.abort();
  }

  // Stops an in-flight agent run (the user pressed Stop). Aborts the current
  // request/tool loop and clears the loading state so the composer is usable
  // again; the partial assistant turn (if any) is kept.
  stop(): void {
    if (!this.isLoading) return;
    this.abort?.abort();
    this.isLoading = false;
    m.redraw();
  }

  // ---- History (persisted per-trace) -------------------------------------

  history(): SavedConversation[] {
    return this.deps.store.list();
  }

  // Restores a saved conversation into the live transcript.
  switchTo(id: string): void {
    const saved = this.deps.store.get(id);
    if (saved === undefined) return;
    this.abort?.abort();
    this.isLoading = false;
    this.pending = [];
    this.input = '';
    this.lastNotedId = undefined;
    this.id = saved.id;
    this.createdAt = saved.createdAt;
    this.turns.length = 0;
    for (const t of saved.turns) {
      this.turns.push({
        role: t.role,
        text: t.text,
        isError: t.isError,
        toolNotes: t.toolNotes ? [...t.toolNotes] : undefined,
        chips: t.chips?.map((c, i) => ({id: `saved-${i}`, label: c.label})),
      });
    }
    m.redraw();
  }

  deleteSaved(id: string): void {
    this.deps.store.remove(id);
    if (id === this.id) this.newChat();
    m.redraw();
  }

  // Serialises the current transcript for persistence (drops live AreaSelection
  // references and the SQL-laden llmContent; keeps only display data).
  private persist(): void {
    if (this.turns.length === 0) return;
    this.deps.store.upsert({
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      turns: this.turns.map((t) => ({
        role: t.role,
        text: t.text,
        isError: t.isError,
        toolNotes: t.toolNotes,
        chips: t.chips?.map((c) => ({label: c.label})),
      })),
    });
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
        const offset = this.deps.alignOffsetForArea?.(chip.area) ?? 0n;
        const ctx = await buildSelectionContext(
          this.deps.engine,
          chip.area,
          offset,
        );
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

    // Assemble the full multi-turn history for the API from prior turns.
    const messages: LlmMessage[] = this.turns
      .slice(0, -1) // exclude the empty assistant turn we just pushed
      .map((t) => ({
        role: t.role,
        content: t.role === 'user' ? t.llmContent ?? t.text : t.text,
      }));

    const toolDefs = this.deps.tools.map((t) => t.def);
    const toolByName = new Map(
      this.deps.tools.map((t) => [t.def.function.name, t]),
    );

    // Open a log round capturing what we send and what the tools return, so the
    // agent loop is inspectable / exportable instead of a black box.
    const logger = this.deps.log.startRound({
      model,
      systemPrompt: this.deps.client.systemPrompt,
      userText: llmContent,
    });
    logger.setRequest(messages);

    try {
      // Agentic loop: stream a turn; if the model asked for tools, run them,
      // feed results back, and continue. Stop when a turn has no tool calls.
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (signal.aborted) break; // User pressed Stop between rounds.
        logger.incRounds();
        let toolCalls: ReadonlyArray<{
          id: string;
          name: string;
          arguments: string;
        }> = [];
        for await (const ev of this.deps.client.send(
          messages,
          model,
          toolDefs,
          signal,
        )) {
          if (ev.textDelta !== undefined && ev.textDelta !== '') {
            assistant.text += ev.textDelta;
            m.redraw();
          }
          if (ev.toolCalls !== undefined) {
            toolCalls = ev.toolCalls;
          }
        }

        if (toolCalls.length === 0) break; // Final answer produced.

        // Record the assistant's tool-call turn, then execute each call and
        // feed the results back as 'tool' messages.
        messages.push({
          role: 'assistant',
          content: assistant.text,
          toolCalls,
        });
        for (const call of toolCalls) {
          if (signal.aborted) break; // User pressed Stop mid tool-loop.
          const tool = toolByName.get(call.name);
          let resultContent: string;
          let note: string;
          let isError = false;
          const callStart = Date.now();
          if (tool === undefined) {
            resultContent = `Error: unknown tool "${call.name}".`;
            note = `unknown tool ${call.name}`;
            isError = true;
          } else {
            try {
              const args = JSON.parse(call.arguments || '{}') as Record<
                string,
                unknown
              >;
              const r = await tool.run(args);
              resultContent = r.content;
              note = r.summary;
            } catch (e: unknown) {
              resultContent = `Error: ${String(e)}`;
              note = `error: ${String(e)}`;
              isError = true;
            }
          }
          logger.addToolCall({
            name: call.name,
            arguments: call.arguments,
            resultSummary: note,
            resultPreview: resultContent,
            durationMs: Date.now() - callStart,
            isError,
          });
          (assistant.toolNotes ??= []).push(note);
          messages.push({
            role: 'tool',
            content: resultContent,
            toolCallId: call.id,
          });
          m.redraw();
        }
      }

      if (assistant.text === '' && (assistant.toolNotes?.length ?? 0) === 0) {
        assistant.text = '(no response)';
      }
    } catch (e: unknown) {
      if ((e as {name?: string}).name !== 'AbortError') {
        assistant.text = `Error: ${String(e)}`;
        assistant.isError = true;
        logger.setError(String(e));
      } else {
        logger.setError('aborted');
      }
    } finally {
      this.isLoading = false;
      logger.commit(assistant.text);
      this.persist();
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
