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

// Builds a text context summary from an AreaSelection for sending to the LLM.

import type {Engine} from '../../trace_processor/engine';
import type {AreaSelection} from '../../public/selection';
import {Duration, Time} from '../../base/time';

export async function buildSelectionContext(
  engine: Engine,
  selection: AreaSelection,
): Promise<string> {
  const durNs = selection.end - selection.start;
  const durMs = Duration.toMilliseconds(durNs).toFixed(3);

  // Resolve the selected tracks to their underlying trace_processor track_ids
  // so the summaries reflect ONLY the selected tracks, not the whole trace.
  // (One UI track can back several sql track_ids; non-slice tracks contribute
  // none.) Mirrors the pattern in core/flow_manager.ts.
  const trackIds: number[] = [];
  for (const t of selection.tracks) {
    if (
      t.renderer?.rootTableName !== undefined &&
      t.renderer.rootTableName !== 'slice'
    ) {
      continue;
    }
    for (const id of t.tags?.trackIds ?? []) trackIds.push(id);
  }
  const uniqueTrackIds = [...new Set(trackIds)];
  // SQL fragment restricting to the selected tracks; empty (no restriction)
  // when we couldn't resolve any track_ids, to preserve prior behaviour.
  const trackFilter =
    uniqueTrackIds.length > 0
      ? `AND track_id IN (${uniqueTrackIds.join(',')})`
      : '';

  const lines: string[] = [
    `## Selected Time Range`,
    `- Start: ${Time.toSeconds(selection.start).toFixed(6)}s`,
    `- End: ${Time.toSeconds(selection.end).toFixed(6)}s`,
    `- Duration: ${durMs}ms`,
    `- Tracks selected: ${selection.tracks.length}` +
      (uniqueTrackIds.length > 0
        ? ` (${uniqueTrackIds.length} sql track_ids)`
        : ''),
    '',
  ];

  if (selection.tracks.length > 0) {
    lines.push(`## Selected Tracks`);
    for (const t of selection.tracks.slice(0, 30)) {
      lines.push(`- ${t.uri}`);
    }
    if (selection.tracks.length > 30) {
      lines.push(`- ... and ${selection.tracks.length - 30} more`);
    }
    lines.push('');
  }

  // Top slices by total duration in the selection window, restricted to the
  // selected tracks.
  try {
    const res = await engine.query(`
      WITH overlapping_slices AS (
        SELECT
          name,
          min(ts + dur, ${selection.end}) - max(ts, ${selection.start}) AS overlap_dur
        FROM slice
        WHERE dur > 0
          AND ts < ${selection.end}
          AND ts + dur > ${selection.start}
          ${trackFilter}
      )
      SELECT
        name,
        count(*) AS cnt,
        CAST(sum(overlap_dur) / 1e6 AS REAL) AS total_ms,
        CAST(avg(overlap_dur) / 1e6 AS REAL) AS avg_ms
      FROM overlapping_slices
      GROUP BY name
      ORDER BY total_ms DESC
      LIMIT 20
    `);
    const iter = res.iter({});
    const rows: string[] = [];
    for (; iter.valid(); iter.next()) {
      const name = String(iter.get('name'));
      const cnt = Number(iter.get('cnt'));
      const totalMs = Number(iter.get('total_ms')).toFixed(3);
      const avgMs = Number(iter.get('avg_ms')).toFixed(3);
      rows.push(
        `  ${name} | count=${cnt} | total=${totalMs}ms | avg=${avgMs}ms`,
      );
    }
    if (rows.length > 0) {
      lines.push(`## Top Slices by Duration`);
      lines.push(`  name | count | total_ms | avg_ms`);
      lines.push(...rows);
      lines.push('');
    }
  } catch {
    // Not all traces have the slice table; skip.
  }

  // If the selected slices carry a `device` arg (XPU/GPU-style traces),
  // summarise busy time per device — purely data-driven, no hard-coded names.
  try {
    const res = await engine.query(`
      WITH sel AS (
        SELECT
          extract_arg(arg_set_id, 'args.device') AS device,
          min(ts + dur, ${selection.end}) - max(ts, ${selection.start}) AS d
        FROM slice
        WHERE dur > 0
          AND ts < ${selection.end}
          AND ts + dur > ${selection.start}
          ${trackFilter}
      )
      SELECT device, count(*) AS cnt, CAST(sum(d) / 1e6 AS REAL) AS total_ms
      FROM sel
      WHERE device IS NOT NULL
      GROUP BY device
      ORDER BY device
      LIMIT 32
    `);
    const iter = res.iter({});
    const rows: string[] = [];
    for (; iter.valid(); iter.next()) {
      const device = Number(iter.get('device'));
      const cnt = Number(iter.get('cnt'));
      const totalMs = Number(iter.get('total_ms')).toFixed(3);
      rows.push(`  device ${device}: count=${cnt} | total=${totalMs}ms`);
    }
    if (rows.length > 0) {
      lines.push(`## Slices by device (args.device)`);
      lines.push(...rows);
      lines.push('');
    }
  } catch {
    // No device arg / no slice table; skip.
  }

  // CPU scheduling latency summary.
  try {
    const res = await engine.query(`
      SELECT
        p.name AS process_name,
        CAST(sum(ss.dur) / 1e6 AS REAL) AS cpu_ms
      FROM thread_state ss
      JOIN thread t USING (utid)
      JOIN process p USING (upid)
      WHERE ss.ts >= ${selection.start}
        AND ss.ts + ss.dur <= ${selection.end}
        AND ss.state = 'Running'
      GROUP BY p.name
      ORDER BY cpu_ms DESC
      LIMIT 10
    `);
    const iter = res.iter({});
    const rows: string[] = [];
    for (; iter.valid(); iter.next()) {
      const pname = String(iter.get('process_name'));
      const cpuMs = Number(iter.get('cpu_ms')).toFixed(3);
      rows.push(`  ${pname}: ${cpuMs}ms CPU`);
    }
    if (rows.length > 0) {
      lines.push(`## CPU Usage by Process (Running state)`);
      lines.push(...rows);
      lines.push('');
    }
  } catch {
    // Skip if thread_state is unavailable.
  }

  return lines.join('\n');
}
