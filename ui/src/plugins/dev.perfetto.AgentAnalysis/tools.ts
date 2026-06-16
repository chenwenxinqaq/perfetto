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

// Tools the AI Analysis agent can call. A read-only trace_processor SQL tool
// lets the model investigate the trace itself; the diff-oriented tools
// (list_loaded_traces, compare_slices_across_traces) encode the multi-trace
// comparison domain (each trace loaded with its own machine_id, optionally
// aligned by a constant per-machine time offset) so the agent can diff two
// runs without rediscovering that structure each time.

import type {Engine} from '../../trace_processor/engine';

// Minimal view of the timeline's cross-trace alignment state. The diff tools
// report each trace's applied offset so the model's time comparisons account
// for any manual alignment the user performed. Kept as a tiny interface (not
// the full Timeline) so tools.ts stays decoupled and easy to unit test.
export interface AlignmentProvider {
  // The constant time offset (ns) applied to a machine's tracks, or undefined.
  machineTimeOffset(machineId: number): bigint | undefined;
}

// Saves a file to the user's machine (a thin seam over base/download_utils so
// tools.ts stays decoupled from the DOM and is unit-testable).
export type DownloadFn = (args: {
  content: string;
  fileName: string;
  mimeType: string;
}) => void;

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
const LIST_TRACES = 'list_loaded_traces';
const COMPARE_SLICES = 'compare_slices_across_traces';
const EXPORT_DATA = 'export_data_to_file';
const MAX_ROWS = 2000;
// Cap exported payloads so a runaway model can't try to write a huge blob.
const MAX_EXPORT_CHARS = 5_000_000;

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

// One loaded trace (one machine_id) in a multi-trace comparison session.
interface LoadedTrace {
  readonly machine: number;
  readonly processCount: number;
  readonly sliceCount: number;
  readonly minTs: number | null;
  readonly maxTs: number | null;
}

// Enumerates the traces loaded together by machine_id. Returns a single
// synthetic machine (id 0) for ordinary single-trace sessions where
// machine_id is NULL, so callers always get at least one row.
async function listLoadedTraces(engine: Engine): Promise<LoadedTrace[]> {
  const res = await engine.query(`
    INCLUDE PERFETTO MODULE slices.with_context;
    WITH m AS (
      SELECT coalesce(p.machine_id, 0) AS machine, p.upid
      FROM process p
    )
    SELECT
      m.machine AS machine,
      count(DISTINCT m.upid) AS process_count,
      (SELECT count(*) FROM thread_or_process_slice s
       WHERE coalesce(
         (SELECT machine_id FROM process WHERE upid = s.upid), 0) = m.machine
      ) AS slice_count,
      (SELECT min(s.ts) FROM thread_or_process_slice s
       WHERE coalesce(
         (SELECT machine_id FROM process WHERE upid = s.upid), 0) = m.machine
      ) AS min_ts,
      (SELECT max(s.ts + s.dur) FROM thread_or_process_slice s
       WHERE coalesce(
         (SELECT machine_id FROM process WHERE upid = s.upid), 0) = m.machine
      ) AS max_ts
    FROM m
    GROUP BY m.machine
    ORDER BY m.machine
  `);
  const out: LoadedTrace[] = [];
  const it = res.iter({});
  for (; it.valid(); it.next()) {
    const min = it.get('min_ts');
    const max = it.get('max_ts');
    out.push({
      machine: Number(it.get('machine')),
      processCount: Number(it.get('process_count')),
      sliceCount: Number(it.get('slice_count')),
      minTs: min === null ? null : Number(min),
      maxTs: max === null ? null : Number(max),
    });
  }
  return out;
}

// Per-trace aggregate of slices matching a name pattern, used to compare the
// same operation across two runs.
interface SliceStatsRow {
  machine: number;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  alignOffsetNs?: number;
}

async function compareSlicesAcrossTraces(
  engine: Engine,
  namePattern: string,
  alignment?: AlignmentProvider,
): Promise<SliceStatsRow[]> {
  // Parameterise via a single-quoted literal: escape any embedded quote so the
  // GLOB pattern can't break out of the string (read-only query regardless).
  const safe = namePattern.replace(/'/g, "''");
  const res = await engine.query(`
    INCLUDE PERFETTO MODULE slices.with_context;
    SELECT
      coalesce(
        (SELECT machine_id FROM process WHERE upid = s.upid), 0) AS machine,
      count(*) AS cnt,
      CAST(sum(s.dur) / 1e6 AS REAL) AS total_ms,
      CAST(avg(s.dur) / 1e6 AS REAL) AS avg_ms,
      CAST(max(s.dur) / 1e6 AS REAL) AS max_ms
    FROM thread_or_process_slice s
    WHERE s.dur > 0 AND s.name GLOB '${safe}'
    GROUP BY machine
    ORDER BY machine
  `);
  const out: SliceStatsRow[] = [];
  const it = res.iter({});
  for (; it.valid(); it.next()) {
    const machine = Number(it.get('machine'));
    const offset = alignment?.machineTimeOffset(machine);
    out.push({
      machine,
      count: Number(it.get('cnt')),
      totalMs: Number(it.get('total_ms')),
      avgMs: Number(it.get('avg_ms')),
      maxMs: Number(it.get('max_ms')),
      alignOffsetNs: offset === undefined ? undefined : Number(offset),
    });
  }
  return out;
}

// Builds the tool set for a trace. When several traces are loaded together for
// comparison (each with its own machine_id), `alignment` lets the diff tools
// report the user's manual time-alignment offsets. Pass undefined when no
// alignment state is available (the diff tools still work, just without
// offsets).
export function buildTools(
  engine: Engine,
  alignment?: AlignmentProvider,
  downloadFn?: DownloadFn,
): Tool[] {
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

  // ---- Diff / multi-trace comparison tools --------------------------------

  const listTraces: Tool = {
    def: {
      type: 'function',
      function: {
        name: LIST_TRACES,
        description:
          'List the traces loaded together in this session for comparison. ' +
          'When opened via "Open traces for comparison (diff)", each trace ' +
          'gets its own machine_id; this returns one row per trace with its ' +
          'machine id, process count, slice count and ts bounds. A single ' +
          'ordinary trace returns one row with machine=0. Call this FIRST in ' +
          'any cross-trace/diff question to learn how many traces there are ' +
          'and their machine ids, then filter other queries by ' +
          'process.machine_id (join slices via slices.with_context ' +
          'thread_or_process_slice.upid -> process.upid).',
        parameters: {type: 'object', properties: {}},
      },
    },
    async run(): Promise<ToolHandlerResult> {
      const traces = await listLoadedTraces(engine);
      return {
        content: JSON.stringify(traces),
        summary: `list_loaded_traces → ${traces.length} trace${
          traces.length === 1 ? '' : 's'
        }`,
      };
    },
  };

  const compareSlices: Tool = {
    def: {
      type: 'function',
      function: {
        name: COMPARE_SLICES,
        description:
          'Compare the same operation across the loaded traces. Given a ' +
          'slice name GLOB pattern (e.g. "Forward*" or "ncclAllReduce*"), ' +
          'returns per-trace (per machine_id) count, total/avg/max duration ' +
          '(ms) so you can spot which run is slower and by how much. If the ' +
          'user manually aligned the traces, each row also includes the ' +
          'applied alignment offset (alignOffsetNs). Use this for ' +
          'regression/A-B questions instead of eyeballing; follow up with ' +
          'run_perfetto_sql for per-slice detail.',
        parameters: {
          type: 'object',
          properties: {
            name_pattern: {
              type: 'string',
              description:
                'A GLOB pattern matched against slice.name (e.g. "Step *", ' +
                '"*AllReduce*"). Use "*" to compare all slices (coarse).',
            },
          },
          required: ['name_pattern'],
        },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolHandlerResult> {
      const pattern = String(args.name_pattern ?? '').trim();
      if (pattern === '') {
        return {
          content: 'Error: name_pattern is required (a slice-name GLOB).',
          summary: COMPARE_SLICES,
        };
      }
      const rows = await compareSlicesAcrossTraces(engine, pattern, alignment);
      return {
        content: JSON.stringify(rows),
        summary: `compare "${pattern}" → ${rows.length} trace${
          rows.length === 1 ? '' : 's'
        }`,
      };
    },
  };

  // ---- Export / download tool ---------------------------------------------

  const exportData: Tool = {
    def: {
      type: 'function',
      function: {
        name: EXPORT_DATA,
        description:
          "Download data to the user's local machine as a file. Use this " +
          'when the user asks to save, export, or download data you have ' +
          'collected or compared (e.g. a metrics table, a diff result, query ' +
          'rows). Provide the FULL file content as a string — typically CSV ' +
          'for tabular data (so it opens in Excel/Sheets) or JSON for nested ' +
          'data. Do NOT paste the whole content back into the chat as well; ' +
          'just call this tool and tell the user the file was downloaded. ' +
          `Max ${Math.round(MAX_EXPORT_CHARS / 1e6)}MB of text.`,
        parameters: {
          type: 'object',
          properties: {
            file_name: {
              type: 'string',
              description:
                'Suggested file name including extension, e.g. ' +
                '"step_latency_comparison.csv" or "slices.json".',
            },
            content: {
              type: 'string',
              description: 'The full file content to save.',
            },
            format: {
              type: 'string',
              enum: ['csv', 'json', 'text'],
              description:
                'Content format; selects the MIME type. Defaults to text.',
            },
          },
          required: ['file_name', 'content'],
        },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolHandlerResult> {
      if (downloadFn === undefined) {
        return {
          content: 'Error: downloading is not available in this context.',
          summary: 'export unavailable',
        };
      }
      const content = String(args.content ?? '');
      if (content === '') {
        return {content: 'Error: content is empty.', summary: EXPORT_DATA};
      }
      if (content.length > MAX_EXPORT_CHARS) {
        return {
          content:
            `Error: content is ${content.length} chars, over the ` +
            `${MAX_EXPORT_CHARS} limit. Aggregate or export a subset.`,
          summary: 'export too large',
        };
      }
      const format = String(args.format ?? 'text');
      const mimeType =
        format === 'csv'
          ? 'text/csv'
          : format === 'json'
            ? 'application/json'
            : 'text/plain';
      // Default an extension matching the format if the model omitted one.
      const rawName = String(args.file_name ?? '').trim();
      const ext = format === 'text' ? 'txt' : format;
      const fileName =
        rawName === ''
          ? `agent_export.${ext}`
          : /\.[^.]+$/.test(rawName)
            ? rawName
            : `${rawName}.${ext}`;
      downloadFn({content, fileName, mimeType});
      const kb = (content.length / 1024).toFixed(1);
      return {
        content: `Downloaded "${fileName}" (${kb} KB) to the user's machine.`,
        summary: `⬇ exported ${fileName} (${kb} KB)`,
      };
    },
  };

  return [runSql, listTraces, compareSlices, exportData];
}

export {RUN_SQL, LIST_TRACES, COMPARE_SLICES, EXPORT_DATA};
