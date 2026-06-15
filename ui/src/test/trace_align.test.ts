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

// Tests the cross-trace timeline alignment state on the Timeline object.
//
// Full two-trace alignment requires each trace to have its own machine_id,
// which is produced by the trace_processor `separate_machine_per_trace_file`
// option (a C++ change verified in CI). Here we exercise the UI-side state
// machine that the alignment controller drives: setting a per-machine time
// offset shifts that machine, hasTimeAlignment reflects it, and reset clears.

import {test, type Page, expect} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

test.beforeAll(async ({browser}, testInfo) => {
  testInfo.setTimeout(240_000);
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await page.goto('/?testing=1', {waitUntil: 'load', timeout: 180_000});
  await pth.waitForPerfettoIdle();
  await pth.openTraceFile('api34_startup_cold.perfetto-trace');
});

test('per-machine alignment offset is recorded and cleared', async () => {
  const result = await page.evaluate(() => {
    const tl = self.app.trace!.timeline;
    // No offset initially.
    const before = tl.hasTimeAlignment;
    // Apply an offset to machine 1 (as the alignment controller would).
    tl.setMachineTimeOffset(1, 4000n as unknown as bigint);
    const offset = tl.machineTimeOffset(1);
    const has = tl.hasTimeAlignment;
    // Other machines are unaffected.
    const other = tl.machineTimeOffset(2);
    // Reset clears everything.
    tl.clearTimeAlignment();
    const after = tl.hasTimeAlignment;
    return {
      before,
      offset: offset === undefined ? null : Number(offset),
      has,
      other: other === undefined ? null : Number(other),
      after,
    };
  });

  expect(result.before).toBe(false);
  expect(result.offset).toBe(4000);
  expect(result.has).toBe(true);
  expect(result.other).toBeNull();
  expect(result.after).toBe(false);
});

test('setting offset to zero removes the machine alignment', async () => {
  const result = await page.evaluate(() => {
    const tl = self.app.trace!.timeline;
    tl.setMachineTimeOffset(3, 1234n as unknown as bigint);
    const had = tl.hasTimeAlignment;
    tl.setMachineTimeOffset(3, 0n as unknown as bigint);
    return {had, after: tl.hasTimeAlignment};
  });
  expect(result.had).toBe(true);
  expect(result.after).toBe(false);
});
