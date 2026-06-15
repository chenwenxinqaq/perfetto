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
