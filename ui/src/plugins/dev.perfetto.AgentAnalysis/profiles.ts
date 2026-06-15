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

// Loads user-configurable "prompt profiles" that teach the agent about
// domain-specific trace shapes (e.g. XPU compute-card captures) WITHOUT
// hard-coding any business semantics in the plugin.
//
// A profile has a `match` query (a count; >0 means it applies to this trace)
// and a `prompt` appended to the system prompt when matched. Profiles are
// supplied as JSON via a setting, so they can be changed without a rebuild.

import {z} from 'zod';
import type {Engine} from '../../trace_processor/engine';

const PROFILE_SCHEMA = z.object({
  name: z.string(),
  // A read-only SQL query returning a single numeric count in its first
  // row/column. The profile applies when that count is > 0.
  match: z.string(),
  // Text appended to the system prompt when this profile matches.
  prompt: z.string(),
});

const PROFILES_SCHEMA = z.object({
  profiles: z.array(PROFILE_SCHEMA),
});

export type PromptProfile = z.infer<typeof PROFILE_SCHEMA>;

// Parses the profiles JSON (returns [] on empty/invalid input).
export function parseProfiles(configJson: string): PromptProfile[] {
  const trimmed = configJson.trim();
  if (trimmed === '') return [];
  try {
    const res = PROFILES_SCHEMA.safeParse(JSON.parse(trimmed));
    return res.success ? res.data.profiles : [];
  } catch {
    return [];
  }
}

// Returns true only for read-only match queries (defense against a malicious
// or mistaken config running mutations).
function isReadOnly(query: string): boolean {
  const head = query
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .toLowerCase();
  if (
    !(
      head.startsWith('select') ||
      head.startsWith('with') ||
      head.startsWith('include perfetto module')
    )
  ) {
    return false;
  }
  return !/\b(insert|update|delete|drop|alter|create|attach|detach)\b/i.test(
    head,
  );
}

// Runs each profile's match query in order and returns the prompt of the first
// one that matches (count > 0). Returns '' if none match or config is empty.
export async function pickProfilePrompt(
  engine: Engine,
  configJson: string,
): Promise<string> {
  const profiles = parseProfiles(configJson);
  for (const profile of profiles) {
    if (!isReadOnly(profile.match)) continue;
    try {
      const res = await engine.query(profile.match);
      const it = res.iter({});
      if (!it.valid()) continue;
      const cols = res.columns();
      if (cols.length === 0) continue;
      const v = it.get(cols[0]);
      const count = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
      if (count > 0) return profile.prompt;
    } catch {
      // Bad match query; skip this profile.
    }
  }
  return '';
}
