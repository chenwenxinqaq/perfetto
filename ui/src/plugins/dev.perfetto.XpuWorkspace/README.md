# XPU device workspace (`dev.perfetto.XpuWorkspace`)

Re-organises XPU compute-card traces (Chrome-JSON) so the relationship between
each hardware device and the CPU process that drives it is visible, and
publishes a reusable SQL view that the AI Analysis plugin and the (future)
trace-diff tool can build on.

## What it does

On trace load, for traces that contain `XPU<n> HW(<bdf>)` processes:

1. **Publishes the `xpu_device_map` SQL view** (see contract below).
2. **Builds a "By XPU Device" workspace** and switches to it. Each device gets
   a `Device <n>` group containing, adjacently, its `xpu_hw` process and its
   `cpu_dispatch` process (the latter renamed `CPU dispatch (pid <pid>)` since
   these processes have no name). Both are tagged with a `device <n>` chip.

The original default workspace is left untouched — switch back any time via the
workspace selector in the top toolbar.

## The `xpu_device_map` view (stable contract)

```sql
SELECT * FROM xpu_device_map;
-- columns:
--   upid          INT     trace-processor process id (UNSTABLE across runs)
--   pid           INT     OS pid (stable per run; identifies the dispatch proc)
--   process_name  STRING  e.g. 'XPU0 HW(0000:af:00.0)'; NULL for dispatch procs
--   device        INT     hardware device index 0..N  (STABLE join key)
--   role          STRING  'xpu_hw' | 'cpu_dispatch'   (STABLE join key)
```

The mapping is derived from the integer `device` arg (`args.device`) carried by
every kernel/event slice; a process is attributed to whichever device its
slices tag.

### For the AI agent

Query `xpu_device_map` to answer "which CPU process drives XPU3?" etc.:

```sql
SELECT * FROM xpu_device_map WHERE device = 3;
```

### For the trace-diff tool

Join on the **stable** keys `device` + `role` (and `process_name`/`pid`), never
on `upid`/`track_id` (which are reassigned every run — see the repo CLAUDE.md).
Example: compare per-device HW busy time between two traces by aggregating each
trace's slices grouped by `(device, role)`.

## Notes

- Device attribution requires slices to carry the `args.device` arg. Traces
  without it are left in the default layout (the workspace is only built when at
  least one `XPU* HW(*` process is present).
- Per-group header colors are not exposed by the Perfetto track API, so related
  processes are marked with a text `device <n>` chip plus grouping + naming
  rather than a color tag.
