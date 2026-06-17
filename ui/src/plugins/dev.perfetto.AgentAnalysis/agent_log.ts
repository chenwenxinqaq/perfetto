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

// A lightweight, inspectable log of the AI Analysis agent's recent rounds, so
// the otherwise black-box agent loop (what was actually sent to the model, what
// tools it called with which args, what each returned, how long it took, any
// errors) can be reviewed and exported. One "round" = one user send(), spanning
// however many tool-call iterations it took to produce the final answer.
//
// Kept per-trace in localStorage (like history_store.ts) but capped to the last
// few rounds and with truncated payloads, since this is for debugging not
// archival.

import {z} from 'zod';

const STORAGE_KEY = 'dev.perfetto.AgentAnalysis.agentLog';

// How many rounds to keep per trace (oldest evicted first).
const MAX_ROUNDS_PER_TRACE = 20;
// Cap on trace buckets, to bound total localStorage growth.
const MAX_TRACES = 30;
// Truncate any single captured string to keep the log small.
const MAX_FIELD_CHARS = 20_000;

function truncate(s: string, max = MAX_FIELD_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

// One message exactly as it was sent to the model this round.
const LOGGED_MESSAGE_SCHEMA = z.object({
  role: z.string(),
  content: z.string(),
  // For assistant tool-call turns / tool results, so the wire shape is visible.
  toolCalls: z
    .array(z.object({name: z.string(), arguments: z.string()}))
    .optional(),
  toolCallId: z.string().optional(),
});
export type LoggedMessage = z.infer<typeof LOGGED_MESSAGE_SCHEMA>;

// Loose input shape accepted by setRequest (the conversation's LlmMessage has
// readonly fields; we normalise into LoggedMessage when storing).
export interface MessageLike {
  readonly role: string;
  readonly content: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly arguments: string;
  }>;
  readonly toolCallId?: string;
}

// One tool invocation within the round.
const LOGGED_TOOL_CALL_SCHEMA = z.object({
  name: z.string(),
  arguments: z.string(), // Raw JSON args string the model produced.
  resultSummary: z.string(), // The short human label.
  resultPreview: z.string(), // (Truncated) full result content fed back.
  durationMs: z.number(),
  isError: z.boolean(),
});
export type LoggedToolCall = z.infer<typeof LOGGED_TOOL_CALL_SCHEMA>;

const LOG_ROUND_SCHEMA = z.object({
  id: z.string(),
  ts: z.number(), // When the round started (epoch ms).
  model: z.string(),
  systemPrompt: z.string(),
  userText: z.string(),
  // The full message array sent on the FIRST request of the round.
  request: z.array(LOGGED_MESSAGE_SCHEMA),
  toolCalls: z.array(LOGGED_TOOL_CALL_SCHEMA),
  responseText: z.string(), // Final assistant answer text.
  rounds: z.number(), // Tool-call iterations taken.
  durationMs: z.number(), // Wall-clock for the whole round.
  error: z.string().optional(),
});
export type LogRound = z.infer<typeof LOG_ROUND_SCHEMA>;

const STORE_SCHEMA = z.record(z.string(), z.array(LOG_ROUND_SCHEMA));
type Store = z.infer<typeof STORE_SCHEMA>;

// Builder that accumulates one round's events, then commits it to the store.
// Mutating methods are no-ops after commit(), so a half-built round from an
// aborted send() is still safe to finalise.
export class RoundLogger {
  private readonly round: LogRound;
  private committed = false;
  private readonly start = Date.now();

  constructor(
    private readonly store: AgentLogStore,
    init: {model: string; systemPrompt: string; userText: string},
  ) {
    this.round = {
      id: `log-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      ts: this.start,
      model: init.model,
      systemPrompt: truncate(init.systemPrompt),
      userText: truncate(init.userText),
      request: [],
      toolCalls: [],
      responseText: '',
      rounds: 0,
      durationMs: 0,
    };
  }

  setRequest(messages: ReadonlyArray<MessageLike>): void {
    this.round.request = messages.map((m) => ({
      role: m.role,
      content: truncate(m.content),
      toolCalls: m.toolCalls?.map((c) => ({
        name: c.name,
        arguments: truncate(c.arguments),
      })),
      toolCallId: m.toolCallId,
    }));
  }

  addToolCall(call: LoggedToolCall): void {
    this.round.toolCalls.push({
      ...call,
      arguments: truncate(call.arguments),
      resultSummary: truncate(call.resultSummary, 2_000),
      resultPreview: truncate(call.resultPreview),
    });
  }

  incRounds(): void {
    this.round.rounds++;
  }

  setError(message: string): void {
    this.round.error = truncate(message, 4_000);
  }

  // Finalises the round (response text + duration) and persists it.
  commit(responseText: string): void {
    if (this.committed) return;
    this.committed = true;
    this.round.responseText = truncate(responseText);
    this.round.durationMs = Date.now() - this.start;
    this.store.append(this.round);
  }
}

// Per-trace view over the persisted agent log.
export class AgentLogStore {
  private readonly key: string;

  constructor(traceUuid: string) {
    this.key = traceUuid === '' ? '<no-uuid>' : traceUuid;
  }

  // Starts a new round; call commit() on the returned logger when done.
  startRound(init: {
    model: string;
    systemPrompt: string;
    userText: string;
  }): RoundLogger {
    return new RoundLogger(this, init);
  }

  // Most-recent-first list of this trace's logged rounds.
  list(): LogRound[] {
    const all = loadStore()[this.key] ?? [];
    return [...all].sort((a, b) => b.ts - a.ts);
  }

  clear(): void {
    const store = loadStore();
    if (store[this.key] === undefined) return;
    delete store[this.key];
    saveStore(store);
  }

  // Appends a finished round and enforces the per-trace cap.
  append(round: LogRound): void {
    const store = loadStore();
    const list = store[this.key] ?? [];
    list.push(round);
    list.sort((a, b) => b.ts - a.ts);
    store[this.key] = list.slice(0, MAX_ROUNDS_PER_TRACE);
    saveStore(store);
  }
}

function loadStore(): Store {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return {};
  try {
    const res = STORE_SCHEMA.safeParse(JSON.parse(raw));
    return res.success ? res.data : {};
  } catch {
    return {};
  }
}

function saveStore(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length > MAX_TRACES) {
    const newestPerKey = keys.map((k) => ({
      k,
      newest: Math.max(0, ...store[k].map((r) => r.ts)),
    }));
    newestPerKey.sort((a, b) => b.newest - a.newest);
    const pruned: Store = {};
    for (const {k} of newestPerKey.slice(0, MAX_TRACES)) {
      pruned[k] = store[k];
    }
    store = pruned;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full/unavailable; logging is best-effort.
  }
}
