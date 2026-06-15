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

// End-to-end test for the dev.perfetto.XpuWorkspace plugin.
//
// Builds a small synthetic Chrome-JSON trace in-memory (so nothing needs to be
// checked into the GCS-backed test/data dir) shaped like a real XPU
// compute-card capture: two devices, each with an "XPU<n> HW(...)" hardware
// process and a numeric CPU dispatch process, linked by an `args.device` slice
// arg. It verifies:
//   1. The reusable `xpu_device_map` SQL view pairs each device with its HW and
//      CPU processes.
//   2. A "By XPU Device" workspace is auto-created, made current, and groups
//      each device's HW + CPU processes adjacently with a `device <n>` chip.

import {test, type Page, expect} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

test.describe.configure({mode: 'serial'});

// A minimal two-device XPU trace in Chrome JSON format.
const SYNTHETIC_TRACE = JSON.stringify([
  // HW process metadata (string pids -> become process.name).
  {
    ph: 'M',
    pid: 'XPU0 HW(0000:af:00.0)',
    name: 'process_sort_index',
    cat: '__metadata',
    args: {sort_index: -1024},
  },
  {
    ph: 'M',
    pid: 'XPU1 HW(0000:b2:00.0)',
    name: 'process_sort_index',
    cat: '__metadata',
    args: {sort_index: -1023},
  },
  // Device 0 HW slices.
  {
    ph: 'X',
    pid: 'XPU0 HW(0000:af:00.0)',
    tid: 'SSE-Channel-0',
    ts: 1000,
    dur: 500,
    cat: 'cluster',
    name: 'xpu_kernel_dev0_a',
    args: {device: 0, cu_type: 'cluster'},
  },
  {
    ph: 'X',
    pid: 'XPU0 HW(0000:af:00.0)',
    tid: 'SSE-Channel-1',
    ts: 1200,
    dur: 300,
    cat: 'sdnn',
    name: 'xpu_kernel_dev0_b',
    args: {device: 0, cu_type: 'sdnn'},
  },
  // Device 1 HW slices.
  {
    ph: 'X',
    pid: 'XPU1 HW(0000:b2:00.0)',
    tid: 'SSE-Channel-0',
    ts: 1000,
    dur: 500,
    cat: 'cluster',
    name: 'xpu_kernel_dev1_a',
    args: {device: 1, cu_type: 'cluster'},
  },
  // Device 0 CPU dispatch process (numeric pid, no name).
  {
    ph: 'X',
    pid: 2493,
    tid: 'Stream-8',
    ts: 900,
    dur: 120,
    cat: 'TaskSystemKernel',
    name: 'launch_dev0_a',
    args: {device: 0, stream: 8},
  },
  {
    ph: 'X',
    pid: 2493,
    tid: 'Stream-9',
    ts: 1100,
    dur: 90,
    cat: 'TaskSystemKernel',
    name: 'launch_dev0_b',
    args: {device: 0, stream: 9},
  },
  // Device 1 CPU dispatch process.
  {
    ph: 'X',
    pid: 2498,
    tid: 'Stream-8',
    ts: 900,
    dur: 120,
    cat: 'TaskSystemKernel',
    name: 'launch_dev1_a',
    args: {device: 1, stream: 8},
  },
]);

let pth: PerfettoTestHelper;
let page: Page;

test.beforeAll(async ({browser}, testInfo) => {
  testInfo.setTimeout(240_000);
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await page.goto('/?testing=1', {waitUntil: 'load', timeout: 180_000});
  await pth.waitForPerfettoIdle();

  // Feed the in-memory trace through the hidden file input.
  const file = await page.waitForSelector('input.trace_file', {
    state: 'attached',
  });
  await page.evaluate(() =>
    localStorage.setItem('dismissedPanningHint', 'true'),
  );
  await file.setInputFiles({
    name: 'xpu_grouping_synthetic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SYNTHETIC_TRACE, 'utf8'),
  });
  await pth.waitForPerfettoIdle();
});

test('xpu_device_map view pairs each device with its HW and CPU processes', async () => {
  const rows = await page.evaluate(async () => {
    const e = self.app.trace!.engine;
    const r = await e.query(
      `SELECT device, role, process_name, pid FROM xpu_device_map
       ORDER BY device, role`,
    );
    const it = r.iter({});
    const cols = r.columns();
    const out: Array<Record<string, unknown>> = [];
    for (; it.valid(); it.next()) {
      const row: Record<string, unknown> = {};
      for (const c of cols) {
        const v = it.get(c);
        row[c] = typeof v === 'bigint' ? Number(v) : v;
      }
      out.push(row);
    }
    return out;
  });

  // device 0: cpu_dispatch (pid 2493) + xpu_hw (XPU0); device 1: 2498 + XPU1.
  expect(rows).toEqual([
    {device: 0, role: 'cpu_dispatch', process_name: null, pid: 2493},
    {
      device: 0,
      role: 'xpu_hw',
      process_name: 'XPU0 HW(0000:af:00.0)',
      pid: expect.any(Number),
    },
    {device: 1, role: 'cpu_dispatch', process_name: null, pid: 2498},
    {
      device: 1,
      role: 'xpu_hw',
      process_name: 'XPU1 HW(0000:b2:00.0)',
      pid: expect.any(Number),
    },
  ]);
});

test('a "By XPU Device" workspace is built and grouped by device', async () => {
  const info = await page.evaluate(() => {
    const ws = self.app.trace!.workspaces;
    const current = ws.currentWorkspace;
    // Describe each top-level device group: its name and the names of the
    // process groups (children) inside it.
    const groups = current.children.map((g) => ({
      name: g.name,
      children: g.children.map((c) => ({
        name: c.name,
        chips: c.chips ?? [],
      })),
    }));
    return {
      currentTitle: current.title,
      isInList: ws.all.some((w) => w.title === 'By XPU Device'),
      groups,
    };
  });

  // The custom workspace is current and registered in the switcher.
  expect(info.currentTitle).toBe('By XPU Device');
  expect(info.isInList).toBe(true);

  // One group per device, ordered.
  const deviceGroups = info.groups.filter((g) => /^Device \d+$/.test(g.name));
  expect(deviceGroups.map((g) => g.name)).toEqual(['Device 0', 'Device 1']);

  // Device 0 group contains both an XPU HW process and a renamed CPU dispatch
  // process, each tagged with a "device 0" chip.
  const dev0 = deviceGroups[0];
  expect(dev0.children.length).toBe(2);
  expect(dev0.children.some((c) => /^XPU0 HW/.test(c.name))).toBe(true);
  expect(
    dev0.children.some((c) => /^CPU dispatch \(pid 2493\)/.test(c.name)),
  ).toBe(true);
  for (const child of dev0.children) {
    expect(child.chips).toContain('device 0');
  }
});
