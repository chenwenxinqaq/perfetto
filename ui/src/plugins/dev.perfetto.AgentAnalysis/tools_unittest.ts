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
