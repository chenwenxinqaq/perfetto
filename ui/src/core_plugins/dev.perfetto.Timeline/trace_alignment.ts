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

// Manual cross-trace timeline alignment.
//
// When several traces are loaded together (e.g. via "Open traces for
// comparison") they share one timeline but their clocks are unrelated, so the
// same logical moment sits at different ts. Each trace is given its own
// machine_id at load time, so this lets the user align them: enter alignment
// mode, click a kernel/slice in one trace and another in a second trace, and
// the ENTIRE second trace (all tracks of that machine) is shifted by a constant
// offset so the two picked events line up (by start or end time). The shift is
// applied at render time in track_view.ts via Timeline.setMachineTimeOffset —
// no track SQL changes needed.

import {type time, type duration, Time} from '../../base/time';
import {LONG, NUM} from '../../trace_processor/query_result';
import type {Size2D} from '../../base/geom';
import type {TimeScale} from '../../base/time_scale';
import {drawVerticalLineAtTime} from '../../base/vertical_line_helper';
import type {Overlay, TrackBounds} from '../../public/track';
import type {CanvasColors} from '../../public/canvas_colors';
import type {TraceImpl} from '../../core/trace_impl';

export type AlignEdge = 'start' | 'end';

// One captured anchor: which machine (trace) and the chosen edge timestamp.
interface Anchor {
  readonly machine: number;
  readonly edgeTs: time;
}

export class TraceAlignmentController {
  private _active = false;
  private _edge: AlignEdge = 'start';
  private anchorA?: Anchor;
  private anchorB?: Anchor;
  // The selection key we last consumed, so each new click is captured once.
  private lastKey?: string;

  constructor(private readonly trace: TraceImpl) {}

  get active(): boolean {
    return this._active;
  }
  get edge(): AlignEdge {
    return this._edge;
  }
  get anchors(): {a?: Anchor; b?: Anchor} {
    return {a: this.anchorA, b: this.anchorB};
  }

  setEdge(edge: AlignEdge): void {
    this._edge = edge;
  }

  // Enters alignment mode: the next two clicked track events become anchors.
  enter(): void {
    this._active = true;
    this.anchorA = undefined;
    this.anchorB = undefined;
    this.lastKey = this.selectionKey();
  }

  exit(): void {
    this._active = false;
  }

  // Clears all alignment offsets and any in-progress capture.
  reset(): void {
    this.anchorA = undefined;
    this.anchorB = undefined;
    this._active = false;
    this.trace.timeline.clearTimeAlignment();
  }

  // Initial automatic alignment for the diff workflow: line every trace up by
  // the start time of its FIRST kernel on its FIRST channel. Concretely, for
  // each machine we take the earliest slice ts across that machine's tracks
  // (that earliest ts necessarily lies on whichever channel started first), and
  // shift each machine so all those first-kernel starts coincide with the
  // earliest machine's. Runs once when multiple traces are loaded together;
  // the user can still refine manually afterwards or Reset.
  async autoAlignByFirstKernel(): Promise<void> {
    const res = await this.trace.engine.query(`
      INCLUDE PERFETTO MODULE slices.with_context;
      SELECT
        coalesce(
          (SELECT machine_id FROM process WHERE upid = s.upid), 0) AS machine,
        min(s.ts) AS first_ts
      FROM thread_or_process_slice s
      WHERE s.dur >= 0
      GROUP BY machine
      ORDER BY machine
    `);
    const firstTsByMachine = new Map<number, bigint>();
    for (
      const it = res.iter({machine: NUM, first_ts: LONG});
      it.valid();
      it.next()
    ) {
      firstTsByMachine.set(it.machine, it.first_ts);
    }
    // Need at least two traces (machines) for alignment to mean anything.
    if (firstTsByMachine.size < 2) return;

    // Reference = the machine whose first kernel starts earliest; every other
    // machine is shifted left/right so its first kernel lands on the reference.
    const reference = [...firstTsByMachine.values()].reduce((a, b) =>
      a < b ? a : b,
    );
    for (const [machine, firstTs] of firstTsByMachine) {
      const offset = (reference - firstTs) as duration;
      if (offset !== 0n) {
        this.trace.timeline.setMachineTimeOffset(machine, offset);
      }
    }
  }

  // Called every frame by the overlay while active: if the selection changed to
  // a new track event, capture it as the next anchor.
  pollSelection(): void {
    if (!this._active) return;
    const key = this.selectionKey();
    if (key === undefined || key === this.lastKey) return;
    this.lastKey = key;
    this.capture();
  }

  // Resolves the current track-event selection into an anchor (which machine it
  // belongs to + the chosen edge ts) and stores it as A (first) or B (second);
  // once both are set on different machines, applies the alignment.
  private capture(): void {
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'track_event') return;
    const tags = this.trace.tracks.getTrack(sel.trackUri)?.tags;
    if (tags === undefined) return;
    let machine: number | undefined;
    if (tags.utid !== undefined) {
      machine = this.trace.timeline.machineForUtid(tags.utid);
    } else if (tags.upid !== undefined) {
      machine = this.trace.timeline.machineForUpid(tags.upid);
    }
    if (machine === undefined) return;

    const endTs = Time.fromRaw(
      sel.ts + (sel.dur !== undefined && sel.dur > 0n ? sel.dur : 0n),
    );
    const edgeTs = this._edge === 'start' ? sel.ts : endTs;
    const anchor: Anchor = {machine, edgeTs};

    if (this.anchorA === undefined) {
      this.anchorA = anchor;
    } else if (anchor.machine === this.anchorA.machine) {
      // Same trace clicked again — treat as re-picking A.
      this.anchorA = anchor;
    } else {
      this.anchorB = anchor;
      this.apply();
    }
  }

  // Shifts anchor B's machine (the whole trace) so its edge lands on A's edge.
  private apply(): void {
    if (this.anchorA === undefined || this.anchorB === undefined) return;
    const offset = (this.anchorA.edgeTs - this.anchorB.edgeTs) as duration;
    this.trace.timeline.setMachineTimeOffset(this.anchorB.machine, offset);
    this._active = false;
  }

  // A stable key identifying the current track-event selection.
  private selectionKey(): string | undefined {
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'track_event') return undefined;
    return `${sel.trackUri}#${sel.eventId}`;
  }
}

// One controller per trace, shared by the toolbar button and the overlay.
const controllers = new WeakMap<TraceImpl, TraceAlignmentController>();

export function getAlignmentController(
  trace: TraceImpl,
): TraceAlignmentController {
  let c = controllers.get(trace);
  if (c === undefined) {
    c = new TraceAlignmentController(trace);
    controllers.set(trace, c);
  }
  return c;
}

// Overlay that drives capture each frame and draws a guide line at the aligned
// anchor time while alignment is active or applied.
export class TraceAlignmentOverlay implements Overlay {
  constructor(private readonly controller: TraceAlignmentController) {}

  render(
    ctx: CanvasRenderingContext2D,
    timescale: TimeScale,
    size: Size2D,
    _tracks: ReadonlyArray<TrackBounds>,
    colors: CanvasColors,
  ): void {
    this.controller.pollSelection();
    const {a} = this.controller.anchors;
    // Draw a guide line at anchor A's edge (the alignment target) so the user
    // sees where B will be pulled to.
    if (this.controller.active && a !== undefined) {
      drawVerticalLineAtTime(
        ctx,
        timescale,
        a.edgeTs,
        size.height,
        colors.COLOR_TIMELINE_OVERLAY,
      );
    }
  }
}
