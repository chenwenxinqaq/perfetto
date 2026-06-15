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

// Opens several trace files together for comparison, using the SAME fast path
// as "Open multiple trace files" (trace_processor TAR-packs them — no in-JS
// rewriting, so it loads in seconds even for large traces).
//
// Traces with distinct process names load as separate process trees and can be
// lined up with the timeline "Align" tool (pick a kernel in each trace; that
// process group is shifted). This entry exists as a clearly-labelled shortcut
// for the diff/comparison workflow.

import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import MultiTraceOpenPlugin from '../dev.perfetto.MultiTraceOpen';
import {showMultiTraceModal} from '../dev.perfetto.MultiTraceOpen/multi_trace_modal';

const OPEN_CMD = 'dev.perfetto.TraceDiff#Open';

function openFilePicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    if (!input.files || input.files.length === 0) return;
    const files = Array.from(input.files);
    // Reuse the multi-trace modal so the user can review the picked files and
    // add more from other folders before opening. separateMachines keeps each
    // file's processes distinct (own machine_id) so the traces can be told
    // apart and aligned independently.
    showMultiTraceModal(files, {separateMachines: true});
  });
  input.click();
}

export default class TraceDiffPlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.TraceDiff';
  static readonly dependencies = [MultiTraceOpenPlugin];

  static onActivate(app: App): void {
    app.commands.registerCommand({
      id: OPEN_CMD,
      name: 'Open traces for comparison (diff)',
      callback: () => openFilePicker(),
    });
    app.sidebar.addMenuItem({
      commandId: OPEN_CMD,
      section: 'trace_files',
      icon: 'difference',
    });
  }

  async onTraceLoad(): Promise<void> {}
}
