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

// Persists AI Analysis chat conversations to localStorage, keyed by trace.
//
// Mirrors the array+zod localStorage pattern used by
// ui/src/components/widgets/query_history.ts (the core LocalStorage class can't
// round-trip a top-level array, so we talk to window.localStorage directly).

import {z} from 'zod';

const STORAGE_KEY = 'dev.perfetto.AgentAnalysis.history';

// Max saved conversations kept per trace (oldest evicted first).
const MAX_PER_TRACE = 30;
// Safety cap on the number of distinct trace buckets, to bound total growth.
const MAX_TRACES = 50;

const SAVED_CHIP_SCHEMA = z.object({
  label: z.string(),
});

const SAVED_TURN_SCHEMA = z.object({
  role: z.union([z.literal('user'), z.literal('assistant')]),
  text: z.string(),
  isError: z.boolean().optional(),
  toolNotes: z.array(z.string()).optional(),
  chips: z.array(SAVED_CHIP_SCHEMA).optional(),
});

export type SavedTurn = z.infer<typeof SAVED_TURN_SCHEMA>;

const SAVED_CONVERSATION_SCHEMA = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  turns: z.array(SAVED_TURN_SCHEMA),
});

export type SavedConversation = z.infer<typeof SAVED_CONVERSATION_SCHEMA>;

// Map of traceUuid -> list of conversations for that trace.
const STORE_SCHEMA = z.record(z.string(), z.array(SAVED_CONVERSATION_SCHEMA));
type Store = z.infer<typeof STORE_SCHEMA>;

// Per-trace view over the persisted conversation store.
export class ConversationHistoryStore {
  // Conversations with no trace uuid all share a single fallback bucket.
  private readonly key: string;

  constructor(traceUuid: string) {
    this.key = traceUuid === '' ? '<no-uuid>' : traceUuid;
  }

  // Returns this trace's conversations, most-recently-updated first.
  list(): SavedConversation[] {
    const all = loadStore()[this.key] ?? [];
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SavedConversation | undefined {
    return (loadStore()[this.key] ?? []).find((c) => c.id === id);
  }

  // Inserts or updates a conversation, then enforces the per-trace cap.
  upsert(conv: SavedConversation): void {
    const store = loadStore();
    const list = store[this.key] ?? [];
    const idx = list.findIndex((c) => c.id === conv.id);
    if (idx === -1) {
      list.push(conv);
    } else {
      list[idx] = conv;
    }
    // Keep only the most recent MAX_PER_TRACE conversations.
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    store[this.key] = list.slice(0, MAX_PER_TRACE);
    saveStore(store);
  }

  remove(id: string): void {
    const store = loadStore();
    const list = store[this.key];
    if (list === undefined) return;
    store[this.key] = list.filter((c) => c.id !== id);
    if (store[this.key].length === 0) {
      delete store[this.key];
    }
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
  // Bound the number of trace buckets: if we exceed MAX_TRACES, drop the
  // buckets whose newest conversation is oldest.
  const keys = Object.keys(store);
  if (keys.length > MAX_TRACES) {
    const newestPerKey = keys.map((k) => ({
      k,
      newest: Math.max(0, ...store[k].map((c) => c.updatedAt)),
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
    // localStorage full or unavailable; history persistence is best-effort.
  }
}
