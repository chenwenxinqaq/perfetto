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

// The user's CURRENT timeline selection, resolved to trace_processor track_ids
// and a time window, so tools default to "what the user has selected" (e.g. a
// single SSE-Channel track) instead of the whole trace. Returns undefined when
// nothing useful is selected. Read fresh on each tool call (the selection
// changes during a conversation), hence a callback rather than a static value.
export type SelectionProvider = () =>
  | {trackIds: ReadonlyArray<number>; startTs?: number; endTs?: number}
  | undefined;

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
const KERNEL_BREAKDOWN = 'kernel_cost_breakdown';
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

// One leaf kernel's aggregated cost, tagged with module/stage so the model can
// build the module -> stage -> kernel breakdown table (e.g. FA -> flash_attn /
// reduce -> kernel, or MOE -> dispatch/topk/combine -> kernel). module/stage
// come either from the slice nesting (ancestor depth) or from caller-supplied
// name-matching rules, whichever fits the trace.
interface KernelCostRow {
  module: string; // Top group (e.g. FA / MOE), '' if unclassified.
  stage: string; // Sub group (e.g. flash_attention / dispatch), '' if none.
  kernel: string; // Leaf slice name (the kernel).
  costUs: number; // Sum of this leaf kernel's duration (microseconds).
  count: number; // Number of invocations.
  pct: number; // Share of the total window cost (%).
}

// The breakdown plus the grand total so callers can show per-row percentages
// and per-module/per-stage sums.
interface KernelCostBreakdown {
  totalUs: number;
  rows: KernelCostRow[];
}

// A name-based classification rule: any leaf kernel whose name matches the GLOB
// `pattern` is assigned to (module, stage). First matching rule wins, so order
// rules from most to least specific. Used when kernels are flat under a track
// (no ATTN/MOE parent slices to read module/stage from).
interface GroupRule {
  pattern: string; // GLOB matched against the kernel (leaf slice) name.
  module: string;
  stage?: string;
}

// Aggregates per-LEAF-kernel cost into a module -> stage -> kernel table.
//
// Two ways to derive module/stage, chosen by the caller:
//  - rules: classify by the leaf kernel NAME (GLOB -> module/stage). Use this
//    when kernels are flat under a track (the common XPU case, no ATTN/MOE
//    parent slices). First matching rule wins.
//  - otherwise: read module/stage from the slice NESTING (ancestor at
//    moduleDepth / stageDepth).
//
// Restricts to leaf slices only (so parent/child time isn't double-summed), an
// optional time window, machine (trace), explicit track_ids (defaults to the
// user's selected tracks via the SelectionProvider in buildTools), and a
// leaf-name GLOB. Rows come out in EXECUTION (time) order.
async function kernelCostBreakdown(
  engine: Engine,
  opts: {
    startTs?: number;
    endTs?: number;
    machine?: number;
    trackIds?: ReadonlyArray<number>;
    namePattern?: string;
    moduleDepth: number;
    stageDepth: number;
    rules?: ReadonlyArray<GroupRule>;
    limit: number;
  },
): Promise<KernelCostBreakdown> {
  const safePattern = (opts.namePattern ?? '*').replace(/'/g, "''");
  const conds: string[] = ['s.dur > 0', "s.name GLOB '" + safePattern + "'"];
  if (opts.startTs !== undefined && opts.endTs !== undefined) {
    // Overlap test: the slice intersects the [start, end] window.
    conds.push(`s.ts < ${opts.endTs}`, `s.ts + s.dur > ${opts.startTs}`);
  }
  if (opts.trackIds !== undefined && opts.trackIds.length > 0) {
    const ids = opts.trackIds.filter((n) => Number.isFinite(n)).join(',');
    if (ids !== '') conds.push(`s.track_id IN (${ids})`);
  }
  if (opts.machine !== undefined) {
    conds.push(
      `coalesce((SELECT machine_id FROM process WHERE upid = s.upid), 0) = ` +
        `${opts.machine}`,
    );
  }
  const where = conds.join(' AND ');
  const md = Math.trunc(opts.moduleDepth);
  const sd = Math.trunc(opts.stageDepth);

  // module/stage expressions: either a CASE over name rules, or ancestor slice
  // names at the configured depths.
  let moduleExpr: string;
  let stageExpr: string;
  if (opts.rules !== undefined && opts.rules.length > 0) {
    const esc = (p: string) => p.replace(/'/g, "''");
    const moduleCases = opts.rules
      .map(
        (r) => `WHEN l.kernel GLOB '${esc(r.pattern)}' THEN '${esc(r.module)}'`,
      )
      .join(' ');
    const stageCases = opts.rules
      .map(
        (r) =>
          `WHEN l.kernel GLOB '${esc(r.pattern)}' THEN '${esc(r.stage ?? '')}'`,
      )
      .join(' ');
    moduleExpr = `CASE ${moduleCases} ELSE '' END`;
    stageExpr = `CASE ${stageCases} ELSE '' END`;
  } else {
    moduleExpr =
      `coalesce((SELECT a.name FROM ancestor_slice(l.id) a ` +
      `WHERE a.depth = ${md}), '')`;
    stageExpr =
      `coalesce((SELECT a.name FROM ancestor_slice(l.id) a ` +
      `WHERE a.depth = ${sd}), '')`;
  }

  // Leaf = a slice with no children (the actual kernel). We keep min(ts) per
  // group and order by module-first-ts, then stage-first-ts, then
  // kernel-first-ts so the table preserves EXECUTION order. sum(...) OVER () is
  // the grand total across all groups (before LIMIT) so percentages stay right.
  const res = await engine.query(`
    INCLUDE PERFETTO MODULE slices.with_context;
    WITH leaf AS (
      SELECT s.id, s.name AS kernel, s.dur, s.ts
      FROM thread_or_process_slice s
      WHERE ${where}
        AND NOT EXISTS (SELECT 1 FROM slice c WHERE c.parent_id = s.id)
    ),
    grouped AS (
      SELECT
        ${moduleExpr} AS module,
        ${stageExpr} AS stage,
        l.kernel AS kernel,
        sum(l.dur) AS dur_ns,
        count(*) AS cnt,
        min(l.ts) AS first_ts
      FROM leaf l
      GROUP BY module, stage, kernel
    )
    SELECT
      module,
      stage,
      kernel,
      CAST(dur_ns / 1e3 AS REAL) AS cost_us,
      cnt,
      first_ts,
      CAST(sum(dur_ns) OVER () / 1e3 AS REAL) AS total_us,
      min(first_ts) OVER (PARTITION BY module) AS module_ts,
      min(first_ts) OVER (PARTITION BY module, stage) AS stage_ts
    FROM grouped
    ORDER BY module_ts, stage_ts, first_ts
    LIMIT ${opts.limit}
  `);
  const rows: KernelCostRow[] = [];
  let totalUs = 0;
  const it = res.iter({});
  for (; it.valid(); it.next()) {
    totalUs = Number(it.get('total_us'));
    const costUs = Number(it.get('cost_us'));
    rows.push({
      module: String(it.get('module') ?? ''),
      stage: String(it.get('stage') ?? ''),
      kernel: String(it.get('kernel') ?? ''),
      costUs,
      count: Number(it.get('cnt')),
      pct: totalUs > 0 ? Number(((costUs / totalUs) * 100).toFixed(2)) : 0,
    });
  }
  return {totalUs: Number(totalUs.toFixed(3)), rows};
}

// Builds the tool set for a trace. `alignment` lets the diff tools report
// manual cross-trace time offsets; `downloadFn` powers the export tool;
// `selectionProvider` lets the kernel-breakdown tool default to the user's
// CURRENT timeline selection (tracks + time window) instead of the whole trace.
export function buildTools(
  engine: Engine,
  alignment?: AlignmentProvider,
  downloadFn?: DownloadFn,
  selectionProvider?: SelectionProvider,
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

  // ---- Per-kernel cost breakdown (module -> stage -> kernel) --------------

  const kernelBreakdown: Tool = {
    def: {
      type: 'function',
      function: {
        name: KERNEL_BREAKDOWN,
        description:
          "Build a MODULE -> STAGE -> kernel cost table for the user's " +
          'CURRENT timeline selection. IMPORTANT: by default it uses exactly ' +
          'the tracks AND time window the user selected (e.g. one ' +
          'SSE-Channel), so you do NOT need to (and should not) pass ' +
          'start_ts/end_ts/track_ids — leave them out to honour the ' +
          'selection. Returns {totalUs, rows[]}; each row has module, stage, ' +
          'kernel (leaf slice name), cost_us (busy time, microseconds), ' +
          'count, pct (share of total). Only LEAF kernels are counted, so ' +
          'parent/child time is never double-added. Rows come back in ' +
          'EXECUTION (time) order — KEEP that order, do NOT re-sort by cost. ' +
          'Grouping: if the kernels are FLAT under a track (no ATTN/MOE/FA ' +
          'parent slices — the usual XPU case), pass `groups`: a list of ' +
          '{pattern (kernel-name GLOB), module, stage} rules to classify ' +
          'kernels by name (first match wins, order specific->general). E.g. ' +
          '[{pattern:"*flash_attention_decoder_mtp*",module:"FA",stage:' +
          '"flash_attention"},{pattern:"*reduce_decoder_computation_cluster*"' +
          ',module:"FA",stage:"reduce"}]. If instead the trace DOES nest ' +
          'kernels under module/stage parent slices, omit `groups` and it ' +
          'reads module=ancestor depth module_depth (default 0), ' +
          'stage=stage_depth (default 1). To override the selection, pass ' +
          'track_ids and/or start_ts+end_ts explicitly. Per-module/stage ' +
          'sum(us) = add cost_us across rows sharing that module/stage. Use ' +
          'export_data_to_file to download the table as CSV.',
        parameters: {
          type: 'object',
          properties: {
            groups: {
              type: 'array',
              description:
                'Name-based classification rules for flat kernels. First ' +
                'match wins; order specific -> general.',
              items: {
                type: 'object',
                properties: {
                  pattern: {
                    type: 'string',
                    description: 'GLOB matched against the kernel name.',
                  },
                  module: {type: 'string', description: 'Module label.'},
                  stage: {type: 'string', description: 'Stage label.'},
                },
                required: ['pattern', 'module'],
              },
            },
            track_ids: {
              type: 'array',
              items: {type: 'number'},
              description:
                'Restrict to these trace_processor track_ids. Omit to use ' +
                "the user's selected tracks.",
            },
            start_ts: {
              type: 'number',
              description:
                "Window start (trace ns). Omit to use the user's selection.",
            },
            end_ts: {
              type: 'number',
              description:
                "Window end (trace ns). Omit to use the user's selection.",
            },
            machine_id: {
              type: 'number',
              description:
                'Restrict to one loaded trace (see list_loaded_traces).',
            },
            name_pattern: {
              type: 'string',
              description: 'Kernel-name GLOB pre-filter (default "*" = all).',
            },
            module_depth: {
              type: 'number',
              description:
                'Ancestor depth for the module column when NOT using groups ' +
                '(default 0).',
            },
            stage_depth: {
              type: 'number',
              description:
                'Ancestor depth for the stage column when NOT using groups ' +
                '(default 1).',
            },
            limit: {
              type: 'number',
              description: `Max rows (default 500, max ${MAX_ROWS}).`,
            },
          },
        },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolHandlerResult> {
      const num = (v: unknown): number | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      // Parse caller-supplied grouping rules (for flat kernels).
      let rules: GroupRule[] | undefined;
      if (Array.isArray(args.groups)) {
        const parsed: GroupRule[] = [];
        for (const g of args.groups as unknown[]) {
          const o = (g ?? {}) as Record<string, unknown>;
          const pattern = String(o.pattern ?? '').trim();
          const module = String(o.module ?? '').trim();
          if (pattern === '' || module === '') continue;
          parsed.push({pattern, module, stage: String(o.stage ?? '').trim()});
        }
        if (parsed.length > 0) rules = parsed;
      }

      // Default the window/tracks to the user's current selection unless the
      // caller explicitly overrode them.
      const sel = selectionProvider?.();
      let startTs = num(args.start_ts);
      let endTs = num(args.end_ts);
      let trackIds: ReadonlyArray<number> | undefined = Array.isArray(
        args.track_ids,
      )
        ? (args.track_ids as unknown[])
            .map((v) => Number(v))
            .filter((n) => Number.isFinite(n))
        : undefined;
      let scope = 'whole trace';
      const overrodeWindow = startTs !== undefined && endTs !== undefined;
      const overrodeTracks = trackIds !== undefined && trackIds.length > 0;
      if (sel !== undefined && !overrodeWindow && !overrodeTracks) {
        startTs = sel.startTs ?? startTs;
        endTs = sel.endTs ?? endTs;
        trackIds = sel.trackIds.length > 0 ? sel.trackIds : trackIds;
        scope = 'current selection';
      } else if (overrodeTracks || overrodeWindow) {
        scope = 'custom range';
      }

      const haveWindow = startTs !== undefined && endTs !== undefined;
      const limit = Math.min(num(args.limit) ?? 500, MAX_ROWS);
      const namePattern = String(args.name_pattern ?? '*').trim() || '*';
      const result = await kernelCostBreakdown(engine, {
        startTs: haveWindow ? startTs : undefined,
        endTs: haveWindow ? endTs : undefined,
        machine: num(args.machine_id),
        trackIds,
        namePattern,
        moduleDepth: num(args.module_depth) ?? 0,
        stageDepth: num(args.stage_depth) ?? 1,
        rules,
        limit,
      });
      return {
        content: JSON.stringify(result),
        summary:
          `kernel cost breakdown (${scope}) → ${result.rows.length} ` +
          `kernel${result.rows.length === 1 ? '' : 's'}, total ` +
          `${result.totalUs.toFixed(1)}us`,
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

  return [runSql, listTraces, compareSlices, kernelBreakdown, exportData];
}

export {RUN_SQL, LIST_TRACES, COMPARE_SLICES, KERNEL_BREAKDOWN, EXPORT_DATA};
