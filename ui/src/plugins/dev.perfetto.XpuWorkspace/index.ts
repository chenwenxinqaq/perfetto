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

// Re-organises XPU compute-card traces by hardware device.
//
// These traces (Chrome-JSON) contain, per device (0..N):
//   - an "XPU<n> HW(<bdf>)" process: the hardware-side kernel execution
//     (SSE channels, cluster/sdnn units, sub-task-done markers).
//   - a CPU dispatch process (name is null, shown as "Process <pid>"): the
//     host process that submits kernels to that device (Stream-* threads).
// They are linked by an integer `device` arg on every slice.
//
// The default Perfetto layout lists all of these flat and unordered, so the
// XPU<->CPU relationship is invisible. This plugin:
//   1. Publishes a reusable `xpu_device_map` SQL view (device <-> process,
//      with a stable role/device/name key) for the AI agent and the future
//      trace-diff tool to consume.
//   2. Builds a "By XPU Device" workspace that places each device's HW and
//      CPU-dispatch processes adjacently inside a "Device <n>" group, tagged
//      with a `device <n>` chip, and switches to it automatically.

import {NUM, STR_NULL} from '../../trace_processor/query_result';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {TrackNode} from '../../public/workspace';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';

const WORKSPACE_TITLE = 'By XPU Device';

// One process attributed to a device by the `args.device` slice arg.
interface DeviceProcess {
  readonly upid: number;
  readonly pid: number;
  readonly device: number;
  readonly role: 'xpu_hw' | 'cpu_dispatch';
  readonly processName: string | null;
}

export default class XpuWorkspacePlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.XpuWorkspace';
  static readonly dependencies = [ProcessThreadGroupsPlugin];

  async onTraceLoad(trace: Trace): Promise<void> {
    // Publish the reusable device<->process mapping view first, so it exists
    // for the agent / diff tool regardless of whether we re-group the UI.
    await this.createDeviceMapView(trace);

    // The process/thread groups (and their child tracks) are only fully
    // populated once the trace is ready; build the workspace then.
    trace.onTraceReady.addListener(async () => {
      await this.maybeBuildWorkspace(trace);
    });
  }

  // Creates a session-lived view linking each process to its XPU device.
  // Stable join keys for the diff tool: device (0..N), role, process_name/pid
  // (NOT upid/track_id, which are unstable across runs).
  private async createDeviceMapView(trace: Trace): Promise<void> {
    await trace.engine.query(`
      INCLUDE PERFETTO MODULE slices.with_context;
      CREATE OR REPLACE PERFETTO VIEW xpu_device_map AS
      SELECT
        p.upid AS upid,
        p.pid AS pid,
        p.name AS process_name,
        d.device AS device,
        CASE
          WHEN p.name GLOB 'XPU* HW(*' THEN 'xpu_hw'
          ELSE 'cpu_dispatch'
        END AS role
      FROM (
        SELECT upid, extract_arg(arg_set_id, 'args.device') AS device
        FROM thread_or_process_slice
        WHERE extract_arg(arg_set_id, 'args.device') IS NOT NULL
        GROUP BY upid, device
      ) d
      JOIN process p USING (upid)
    `);
  }

  private async maybeBuildWorkspace(trace: Trace): Promise<void> {
    // Don't rebuild if we already made it (e.g. on a re-entrant ready event).
    if (trace.workspaces.all.some((ws) => ws.title === WORKSPACE_TITLE)) {
      return;
    }

    const procs = await this.queryDeviceProcesses(trace);
    // Only re-group traces that actually have XPU hardware processes.
    if (!procs.some((p) => p.role === 'xpu_hw')) return;

    const groups = trace.plugins.getPlugin(ProcessThreadGroupsPlugin);
    const ws = trace.workspaces.createEmptyWorkspace(WORKSPACE_TITLE);

    // Group processes by device, ordered by device index.
    const byDevice = new Map<number, DeviceProcess[]>();
    for (const p of procs) {
      const list = byDevice.get(p.device) ?? [];
      list.push(p);
      byDevice.set(p.device, list);
    }

    for (const device of [...byDevice.keys()].sort((a, b) => a - b)) {
      const deviceGroup = new TrackNode({
        name: `Device ${device}`,
        isSummary: true,
        collapsed: false,
      });
      ws.addChildLast(deviceGroup);

      // HW process(es) first, then the CPU dispatch process, so the
      // controller sits right below the hardware it drives.
      const members = byDevice
        .get(device)!
        .sort((a, b) => a.role.localeCompare(b.role)); // cpu_dispatch < xpu_hw
      for (const member of members) {
        const group = groups.getGroupForProcess(member.upid);
        if (group === undefined) continue;
        const clone = group.clone(true);
        clone.chips = [...(clone.chips ?? []), `device ${device}`];
        // CPU dispatch processes have no name; label them usefully.
        if (member.role === 'cpu_dispatch') {
          clone.name = `CPU dispatch (pid ${member.pid})`;
        }
        deviceGroup.addChildLast(clone);
      }
    }

    trace.workspaces.switchWorkspace(ws);
  }

  // Returns one row per (process, device) that carries device-tagged slices.
  private async queryDeviceProcesses(trace: Trace): Promise<DeviceProcess[]> {
    const res = await trace.engine.query(`
      SELECT upid, pid, device, role, process_name
      FROM xpu_device_map
      ORDER BY device, role
    `);
    const out: DeviceProcess[] = [];
    const it = res.iter({
      upid: NUM,
      pid: NUM,
      device: NUM,
      role: STR_NULL,
      process_name: STR_NULL,
    });
    for (; it.valid(); it.next()) {
      const role = it.role === 'xpu_hw' ? 'xpu_hw' : 'cpu_dispatch';
      out.push({
        upid: it.upid,
        pid: it.pid,
        device: it.device,
        role,
        processName: it.process_name,
      });
    }
    return out;
  }
}
