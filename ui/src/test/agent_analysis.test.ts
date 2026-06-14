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

// End-to-end smoke test for the dev.perfetto.AgentAnalysis plugin.
//
// It exercises the full path without contacting a real LLM:
//   1. Enable the (non-default) plugin via its feature flag.
//   2. Seed the plugin settings (endpoint + token) so the panel is active.
//   3. Mock the OpenAI-compatible /models + streaming /chat/completions APIs.
//   4. Load a real trace, programmatically area-select a sub-range.
//   5. Open the "AI Analysis" tab, verify the model dropdown is populated from
//      /models, switch model, click Analyze, assert the streamed text (built
//      from a real trace_processor query + parsed SSE) is rendered.

import {test, type Page, expect} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';
import type {time} from '../base/time';

test.describe.configure({mode: 'serial'});

const MARKER = 'AGENT_ANALYSIS_E2E_OK';
const ENDPOINT = 'https://mock.invalid/v1/chat/completions';
const MODELS = ['Claude Sonnet 4.6', 'gpt-5.5', 'DeepSeek-V4-Flash'];

let pth: PerfettoTestHelper;
let page: Page;

test.beforeAll(async ({browser}, testInfo) => {
  // The Vite dev server serves unbundled ESM and compiles Perfetto's large
  // module graph on the first real browser navigation, which can take well
  // over the default 60s hook budget on a cold start.
  testInfo.setTimeout(240_000);

  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);

  // Seed localStorage before any app script runs, on every navigation.
  await page.addInitScript(
    (args) => {
      // Start from a clean conversation-history store so re-runs are
      // deterministic (this test asserts exact history counts).
      localStorage.removeItem('dev.perfetto.AgentAnalysis.history');
      localStorage.setItem(
        'perfettoFeatureFlags',
        JSON.stringify({
          'plugin_dev.perfetto.AgentAnalysis': 'OVERRIDE_TRUE',
        }),
      );
      localStorage.setItem(
        'perfettoSettings',
        JSON.stringify({
          'dev.perfetto.AgentAnalysis#Endpoint': args.endpoint,
          'dev.perfetto.AgentAnalysis#Token': 'test-token',
          'dev.perfetto.AgentAnalysis#Model': 'Claude Sonnet 4.6',
        }),
      );
    },
    {endpoint: ENDPOINT},
  );

  // Mock the model list endpoint (OpenAI-compatible shape).
  await page.route('**/v1/models', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        object: 'list',
        data: MODELS.map((id) => ({id, object: 'model'})),
      }),
    });
  });

  // Intercept the LLM call and reply with two OpenAI-style SSE deltas. The
  // first delta echoes the requested model so the test can assert which model
  // was used.
  await page.route('**/v1/chat/completions', async (route) => {
    const req = route.request().postDataJSON() as {model?: string};
    const usedModel = req?.model ?? '?';
    const body =
      `data: {"choices":[{"delta":{"content":"${MARKER} model=${usedModel} "}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"analysis complete."}}]}\n\n` +
      `data: [DONE]\n\n`;
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'text/event-stream'},
      body,
    });
  });

  // Warm up the dev server's module graph with a generous timeout so the
  // subsequent trace-loading navigation is fast.
  await page.goto('/?testing=1', {waitUntil: 'load', timeout: 180_000});
  await pth.waitForPerfettoIdle();

  await pth.openTraceFile('api34_startup_cold.perfetto-trace');
});

test('AI Analysis tab streams a mocked analysis for an area selection', async () => {
  // Programmatically area-select the middle half of the trace across the
  // first handful of real tracks.
  await page.evaluate(() => {
    const trace = self.app.trace!;
    const uris = trace.workspaces.currentWorkspace.flatTracks
      .map((t) => t.uri)
      .filter((u): u is string => Boolean(u))
      .slice(0, 10);
    const start = trace.traceInfo.start as bigint;
    const end = trace.traceInfo.end as bigint;
    const dur = end - start;
    trace.selection.selectArea({
      start: (start + dur / 4n) as unknown as time,
      end: (start + (dur * 3n) / 4n) as unknown as time,
      trackUris: uris,
    });
  });
  await pth.waitForPerfettoIdle();

  // The current-selection drawer auto-opens; switch to our tab.
  await page.getByRole('button', {name: 'AI Analysis'}).click();
  await pth.waitForPerfettoIdle();

  // The model dropdown is populated from the mocked /models endpoint.
  const modelSelect = page.locator('.pf-agent-analysis__model-select');
  await expect(modelSelect.locator('option')).toHaveCount(MODELS.length);

  // Switch to a non-default model and verify it is the one sent to the API.
  await modelSelect.selectOption('gpt-5.5');
  await pth.waitForPerfettoIdle();

  // The selection appears as a pending chip in the composer (it does NOT
  // auto-send, and selecting does not reset any conversation).
  await expect(
    page.locator('.pf-agent-analysis__pending-chips .pf-agent-analysis__chip'),
  ).toHaveCount(1);

  // Type a question and send.
  const sendBtn = page.locator('button[title="Send (Enter)"]');
  await page.locator('.pf-agent-analysis__input').fill('What happened here?');
  await sendBtn.click();

  // A user turn (with the attached chip) and a streamed assistant turn appear.
  const transcript = page.locator('.pf-agent-analysis__transcript');
  await expect(
    transcript.locator('.pf-agent-analysis__msg--user'),
  ).toContainText('What happened here?');
  const assistant = transcript.locator('.pf-agent-analysis__msg--assistant');
  await expect(assistant).toContainText(MARKER, {timeout: 15_000});
  await expect(assistant).toContainText('model=gpt-5.5');
  await expect(assistant).toContainText('analysis complete.');

  // The pending chip is consumed once sent.
  await expect(
    page.locator('.pf-agent-analysis__pending-chips .pf-agent-analysis__chip'),
  ).toHaveCount(0);

  // Follow-up keeps history: ask again, expect a second assistant turn.
  await page.locator('.pf-agent-analysis__input').fill('And the CPU usage?');
  await sendBtn.click();
  await expect(assistant).toHaveCount(2, {timeout: 15_000});

  // "New chat" clears the transcript.
  await page.getByRole('button', {name: 'New chat'}).click();
  await pth.waitForPerfettoIdle();
  await expect(transcript.locator('.pf-agent-analysis__msg')).toHaveCount(0);

  // The previous conversation is archived in the history popup. Open it.
  const historyBtn = page.locator('button[title="Conversation history"]');
  await historyBtn.click();
  const historyItems = page.locator('.pf-agent-analysis__history-item');
  await expect(historyItems).toHaveCount(1);
  await expect(historyItems.first()).toContainText('What happened here?');

  // Clicking a history item restores its transcript.
  await historyItems.first().click();
  await pth.waitForPerfettoIdle();
  await expect(
    transcript.locator('.pf-agent-analysis__msg--user').first(),
  ).toContainText('What happened here?');
  await expect(
    transcript.locator('.pf-agent-analysis__msg--assistant'),
  ).toHaveCount(2);

  // Deleting from the history popup removes it from the list.
  await historyBtn.click();
  await page
    .locator('.pf-agent-analysis__history-item')
    .first()
    .locator('.pf-agent-analysis__history-delete')
    .click();
  await pth.waitForPerfettoIdle();
  await expect(page.locator('.pf-agent-analysis__history-empty')).toBeVisible();
});

test('AI Analysis opens as a standalone page with no selection', async () => {
  // Clear any selection, then navigate to the standalone page (the same route
  // the sidebar entry points at). The chat panel must render without requiring
  // a timeline selection.
  await page.evaluate(() => self.app.trace!.selection.clearSelection());
  await pth.navigate('#!/agent_analysis');
  await pth.waitForPerfettoIdle();

  const panel = page.locator('.pf-agent-analysis-page .pf-agent-analysis');
  await expect(panel).toBeVisible();

  // Start a clean chat on the standalone page (drops any chip/turns carried
  // over from the shared per-trace conversation).
  await page.getByRole('button', {name: 'New chat'}).click();
  await pth.waitForPerfettoIdle();

  // Pick a known-good model explicitly so this test is order-independent.
  await page
    .locator('.pf-agent-analysis__model-select')
    .selectOption('gpt-5.5');
  await page.locator('.pf-agent-analysis__input').fill('Summarize this trace.');
  await page.locator('button[title="Send (Enter)"]').click();

  const assistant = page.locator('.pf-agent-analysis__msg--assistant');
  await expect(assistant).toContainText(MARKER, {timeout: 15_000});
  await expect(assistant).toContainText('model=gpt-5.5');
});
