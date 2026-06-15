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

// Tools the AI Analysis agent can call. Currently a single read-only
// trace_processor SQL tool, so the model can investigate the trace itself
// instead of guessing from a static summary.

import type {Engine} from '../../trace_processor/engine';

// OpenAI-compatible function/tool definition (the `function` half).
export interface ToolDef {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: object; // JSON Schema
  };
}

export interface ToolHandlerResult {
  readonly content: string; // Text fed back to the model as the tool result.
  readonly summary: string; // Short human label shown in the transcript.
}

export interface Tool {
  readonly def: ToolDef;
  run(args: Record<string, unknown>): Promise<ToolHandlerResult>;
}

const RUN_SQL = 'run_perfetto_sql';
const MAX_ROWS = 2000;

// Only allow read-only statements. trace_processor SQL is powerful (CREATE
// PERFETTO TABLE, etc.), but the agent should not mutate session state.
function assertReadOnly(query: string): void {
  // Strip line/block comments before inspecting the leading keyword.
  const stripped = query
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  const head = stripped.toLowerCase();
  const allowed =
    head.startsWith('select') ||
    head.startsWith('with') ||
    head.startsWith('include perfetto module');
  if (!allowed) {
    throw new Error(
      'Only read-only queries are allowed (SELECT / WITH / INCLUDE PERFETTO ' +
        'MODULE). Statements that modify state are rejected.',
    );
  }
  // Defense in depth: reject obvious mutating keywords anywhere.
  if (
    /\b(insert|update|delete|drop|alter|create|attach|detach)\b/i.test(head)
  ) {
    throw new Error('Mutating SQL keywords are not allowed.');
  }
}

// Runs a query and serialises the result rows to a compact JSON string,
// converting bigints to numbers and capping the row count.
async function runReadOnlyQuery(
  engine: Engine,
  query: string,
): Promise<{json: string; rowCount: number}> {
  assertReadOnly(query);
  const result = await engine.query(query);
  const cols = result.columns();
  const rows: Array<Record<string, unknown>> = [];
  const it = result.iter({});
  for (; it.valid(); it.next()) {
    if (rows.length >= MAX_ROWS) {
      throw new Error(
        `Query returned more than ${MAX_ROWS} rows. Add LIMIT or aggregate ` +
          '(GROUP BY / count / sum) so the result is summarised.',
      );
    }
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      const v = it.get(c);
      row[c] = typeof v === 'bigint' ? Number(v) : v;
    }
    rows.push(row);
  }
  return {json: JSON.stringify(rows), rowCount: rows.length};
}

// Builds the tool set for a trace. The optional contextHint is appended to the
// SQL tool description so the model knows what's already been summarised.
export function buildTools(engine: Engine): Tool[] {
  const runSql: Tool = {
    def: {
      type: 'function',
      function: {
        name: RUN_SQL,
        description:
          'Run a READ-ONLY PerfettoSQL query against this trace in ' +
          'trace_processor and get the rows back as JSON. Use this to verify ' +
          'hypotheses with real data instead of guessing. Standard tables: ' +
          'slice(id,ts,dur,track_id,name,arg_set_id), thread_track(id,utid), ' +
          'process_track(id,upid), thread(utid,tid,name,upid), ' +
          'process(upid,pid,name), args(arg_set_id,key,int_value,...). ' +
          "Read a slice arg with extract_arg(arg_set_id,'args.<key>'). " +
          'INCLUDE PERFETTO MODULE slices.with_context; gives ' +
          'thread_or_process_slice(ts,dur,name,upid,utid,track_id,...). ' +
          'Keep results small: prefer GROUP BY / aggregates, always LIMIT. ' +
          `Max ${MAX_ROWS} rows.`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'A single read-only PerfettoSQL statement.',
            },
          },
          required: ['query'],
        },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolHandlerResult> {
      const query = String(args.query ?? '').trim();
      if (query === '') {
        return {content: 'Error: empty query.', summary: 'run_perfetto_sql'};
      }
      const {json, rowCount} = await runReadOnlyQuery(engine, query);
      const oneLine = query.replace(/\s+/g, ' ').trim();
      const label = oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
      return {
        content: json,
        summary: `SQL: ${label} → ${rowCount} row${rowCount === 1 ? '' : 's'}`,
      };
    },
  };
  return [runSql];
}

export {RUN_SQL};
