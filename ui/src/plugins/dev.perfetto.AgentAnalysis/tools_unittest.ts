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

import {describe, expect, it, vi} from 'vitest';
import type {Engine} from '../../trace_processor/engine';
import {buildTools} from './tools';

// A fake engine whose query() records calls and returns an empty result.
function fakeEngine(): {engine: Engine; calls: string[]} {
  const calls: string[] = [];
  const engine = {
    query: vi.fn(async (q: string) => {
      calls.push(q);
      return {
        columns: () => [],
        iter: () => ({valid: () => false, next: () => {}, get: () => null}),
      };
    }),
  } as unknown as Engine;
  return {engine, calls};
}

// A fake engine returning a fixed set of rows for every query.
function fakeEngineWithRows(rows: ReadonlyArray<Record<string, unknown>>): {
  engine: Engine;
  calls: string[];
} {
  const calls: string[] = [];
  const engine = {
    query: vi.fn(async (q: string) => {
      calls.push(q);
      let i = 0;
      return {
        columns: () => Object.keys(rows[0] ?? {}),
        iter: () => ({
          valid: () => i < rows.length,
          next: () => {
            i++;
          },
          get: (c: string) => rows[i]?.[c] ?? null,
        }),
      };
    }),
  } as unknown as Engine;
  return {engine, calls};
}

describe('run_perfetto_sql tool', () => {
  function runSql(engine: Engine) {
    const tools = buildTools(engine);
    const tool = tools.find((t) => t.def.function.name === 'run_perfetto_sql');
    expect(tool).toBeDefined();
    return tool!;
  }

  it('rejects mutating statements without touching the engine', async () => {
    for (const q of [
      'DROP TABLE slice',
      'DELETE FROM slice',
      'CREATE PERFETTO TABLE x AS SELECT 1',
      'UPDATE slice SET dur = 0',
      'insert into slice values (1)',
    ]) {
      const {engine, calls} = fakeEngine();
      const tool = runSql(engine);
      // The guard throws; the conversation loop turns that into a tool error
      // message fed back to the model.
      await expect(tool.run({query: q})).rejects.toThrow();
      expect(calls).toHaveLength(0); // never reached the engine
    }
  });

  it('allows read-only statements through to the engine', async () => {
    for (const q of [
      'SELECT count(*) FROM slice',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'INCLUDE PERFETTO MODULE slices.with_context',
    ]) {
      const {engine, calls} = fakeEngine();
      const tool = runSql(engine);
      const res = await tool.run({query: q});
      expect(calls).toHaveLength(1);
      expect(res.summary).toContain('SQL:');
    }
  });

  it('rejects a query that hides mutation after a comment', async () => {
    const {engine, calls} = fakeEngine();
    const tool = runSql(engine);
    await expect(
      tool.run({query: '-- harmless\nDROP TABLE slice'}),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('diff tools', () => {
  function getTool(engine: Engine, name: string, alignment?: unknown) {
    const tools = buildTools(
      engine,
      alignment as Parameters<typeof buildTools>[1],
    );
    const tool = tools.find((t) => t.def.function.name === name);
    expect(tool).toBeDefined();
    return tool!;
  }

  it('exposes list_loaded_traces and compare_slices_across_traces', () => {
    const {engine} = fakeEngine();
    const names = buildTools(engine).map((t) => t.def.function.name);
    expect(names).toContain('list_loaded_traces');
    expect(names).toContain('compare_slices_across_traces');
  });

  it('list_loaded_traces returns one row per machine', async () => {
    const {engine} = fakeEngineWithRows([
      {machine: 0, process_count: 3, slice_count: 100, min_ts: 10, max_ts: 90},
      {machine: 1, process_count: 4, slice_count: 200, min_ts: 5, max_ts: 80},
    ]);
    const tool = getTool(engine, 'list_loaded_traces');
    const res = await tool.run({});
    const parsed = JSON.parse(res.content) as Array<{machine: number}>;
    expect(parsed).toHaveLength(2);
    expect(parsed[1].machine).toBe(1);
    expect(res.summary).toContain('2 traces');
  });

  it('compare_slices_across_traces requires a name pattern', async () => {
    const {engine, calls} = fakeEngine();
    const tool = getTool(engine, 'compare_slices_across_traces');
    const res = await tool.run({name_pattern: '  '});
    expect(res.content).toContain('required');
    expect(calls).toHaveLength(0); // never queried
  });

  it('compare_slices_across_traces escapes quotes in the GLOB pattern', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {machine: 0, cnt: 5, total_ms: 50, avg_ms: 10, max_ms: 20},
    ]);
    const tool = getTool(engine, 'compare_slices_across_traces');
    await tool.run({name_pattern: "evil' OR '1'='1"});
    // The single quote must be doubled so it can't break out of the literal.
    expect(calls[0]).toContain("evil'' OR ''1''=''1");
  });

  it('compare_slices_across_traces attaches alignment offsets', async () => {
    const {engine} = fakeEngineWithRows([
      {machine: 0, cnt: 5, total_ms: 50, avg_ms: 10, max_ms: 20},
      {machine: 1, cnt: 6, total_ms: 70, avg_ms: 11, max_ms: 25},
    ]);
    const alignment = {
      machineTimeOffset: (m: number) => (m === 1 ? 123n : undefined),
    };
    const tool = getTool(engine, 'compare_slices_across_traces', alignment);
    const res = await tool.run({name_pattern: 'Step*'});
    const parsed = JSON.parse(res.content) as Array<{
      machine: number;
      alignOffsetNs?: number;
    }>;
    expect(parsed[0].alignOffsetNs).toBeUndefined();
    expect(parsed[1].alignOffsetNs).toBe(123);
  });
});

describe('kernel_cost_breakdown tool', () => {
  function getTool(
    engine: Engine,
    selection?: Parameters<typeof buildTools>[3],
  ) {
    const tools = buildTools(engine, undefined, undefined, selection);
    const tool = tools.find(
      (t) => t.def.function.name === 'kernel_cost_breakdown',
    );
    expect(tool).toBeDefined();
    return tool!;
  }

  it('is included in the tool set', () => {
    const {engine} = fakeEngine();
    const names = buildTools(engine).map((t) => t.def.function.name);
    expect(names).toContain('kernel_cost_breakdown');
  });

  it('returns module/stage/kernel/cost rows with total and pct', async () => {
    const {engine} = fakeEngineWithRows([
      {
        module: 'MOE',
        stage: 'share expert',
        kernel: 'fc_bf16',
        cost_us: 250,
        cnt: 3,
        first_ts: 10,
        total_us: 1000,
      },
      {
        module: 'ATTN',
        stage: '',
        kernel: 'all_reduce',
        cost_us: 750,
        cnt: 1,
        first_ts: 20,
        total_us: 1000,
      },
    ]);
    const tool = getTool(engine);
    const res = await tool.run({});
    const parsed = JSON.parse(res.content) as {
      totalUs: number;
      rows: Array<{
        module: string;
        stage: string;
        kernel: string;
        costUs: number;
        pct: number;
      }>;
    };
    expect(parsed.totalUs).toBe(1000);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].module).toBe('MOE');
    expect(parsed.rows[0].stage).toBe('share expert');
    expect(parsed.rows[0].pct).toBe(25);
    expect(parsed.rows[1].pct).toBe(75);
    expect(res.summary).toContain('2 kernels');
  });

  it('orders rows by execution time, not by cost', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: '',
        stage: '',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine);
    await tool.run({});
    // Module/stage/kernel come out in run order; never re-sorted by cost.
    expect(calls[0]).toContain('ORDER BY module_ts, stage_ts, first_ts');
    expect(calls[0]).not.toContain('ORDER BY cost_us');
  });

  it('counts only leaf slices (excludes parents with children)', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: '',
        stage: '',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine);
    await tool.run({});
    expect(calls[0]).toContain('c.parent_id = s.id');
  });

  it('uses the given module_depth and stage_depth', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: '',
        stage: '',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine);
    await tool.run({module_depth: 2, stage_depth: 3});
    expect(calls[0]).toContain('a.depth = 2');
    expect(calls[0]).toContain('a.depth = 3');
  });

  it('only applies the time window when both bounds are given', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: '',
        stage: '',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine);
    // Only start_ts: no window clause should be emitted.
    await tool.run({start_ts: 100});
    expect(calls[0]).not.toContain('s.ts <');
    // Both bounds: window overlap clause present.
    await tool.run({start_ts: 100, end_ts: 200});
    expect(calls[1]).toContain('s.ts < 200');
    expect(calls[1]).toContain('s.ts + s.dur > 100');
  });

  it('escapes quotes in the kernel-name GLOB', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {module: '', stage: '', kernel: 'k', cost_us: 1, cnt: 1, total_us: 1},
    ]);
    const tool = getTool(engine);
    await tool.run({name_pattern: "x' OR '1'='1"});
    expect(calls[0]).toContain("x'' OR ''1''=''1");
  });

  it('defaults to the user selection (track_ids + window)', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: '',
        stage: '',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine, () => ({
      trackIds: [27],
      startTs: 100,
      endTs: 200,
    }));
    const res = await tool.run({}); // no args -> use selection
    expect(calls[0]).toContain('s.track_id IN (27)');
    expect(calls[0]).toContain('s.ts < 200');
    expect(calls[0]).toContain('s.ts + s.dur > 100');
    expect(res.summary).toContain('current selection');
  });

  it('explicit track_ids override the selection', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: '',
        stage: '',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine, () => ({
      trackIds: [27],
      startTs: 1,
      endTs: 2,
    }));
    await tool.run({track_ids: [99]});
    expect(calls[0]).toContain('s.track_id IN (99)');
    expect(calls[0]).not.toContain('s.track_id IN (27)');
  });

  it('classifies flat kernels by name via groups (first match wins)', async () => {
    const {engine, calls} = fakeEngineWithRows([
      {
        module: 'FA',
        stage: 'flash',
        kernel: 'k',
        cost_us: 1,
        cnt: 1,
        first_ts: 0,
        total_us: 1,
      },
    ]);
    const tool = getTool(engine);
    await tool.run({
      groups: [
        {
          pattern: '*flash_attention_decoder_mtp*',
          module: 'FA',
          stage: 'flash',
        },
        {
          pattern: '*reduce_decoder_computation_cluster*',
          module: 'FA',
          stage: 'reduce',
        },
      ],
    });
    // A CASE over the kernel name, not ancestor_slice depth lookups.
    expect(calls[0]).toContain('CASE WHEN l.kernel GLOB');
    expect(calls[0]).toContain("THEN 'FA'");
    expect(calls[0]).not.toContain('ancestor_slice');
  });
});

describe('export_data_to_file tool', () => {
  function getExportTool(
    engine: Engine,
    downloadFn?: Parameters<typeof buildTools>[2],
  ) {
    const tools = buildTools(engine, undefined, downloadFn);
    const tool = tools.find(
      (t) => t.def.function.name === 'export_data_to_file',
    );
    expect(tool).toBeDefined();
    return tool!;
  }

  it('is included in the tool set', () => {
    const {engine} = fakeEngine();
    const names = buildTools(engine).map((t) => t.def.function.name);
    expect(names).toContain('export_data_to_file');
  });

  it('passes content and file name through to the download fn', async () => {
    const {engine} = fakeEngine();
    const saved: Array<{content: string; fileName: string; mimeType: string}> =
      [];
    const tool = getExportTool(engine, (a) => saved.push(a));
    const res = await tool.run({
      file_name: 'data.csv',
      content: 'a,b\n1,2\n',
      format: 'csv',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].fileName).toBe('data.csv');
    expect(saved[0].content).toBe('a,b\n1,2\n');
    expect(saved[0].mimeType).toBe('text/csv');
    expect(res.summary).toContain('exported');
  });

  it('appends an extension matching the format when missing', async () => {
    const {engine} = fakeEngine();
    const saved: Array<{fileName: string}> = [];
    const tool = getExportTool(engine, (a) => saved.push(a));
    await tool.run({file_name: 'metrics', content: '{}', format: 'json'});
    expect(saved[0].fileName).toBe('metrics.json');
  });

  it('rejects empty content without downloading', async () => {
    const {engine} = fakeEngine();
    let called = false;
    const tool = getExportTool(engine, () => {
      called = true;
    });
    const res = await tool.run({file_name: 'x.csv', content: ''});
    expect(called).toBe(false);
    expect(res.content).toContain('empty');
  });

  it('reports gracefully when downloading is unavailable', async () => {
    const {engine} = fakeEngine();
    const tool = getExportTool(engine, undefined);
    const res = await tool.run({file_name: 'x.csv', content: 'a'});
    expect(res.content).toContain('not available');
  });
});
