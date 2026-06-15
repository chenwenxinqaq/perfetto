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

// Minimal streaming LLM client supporting OpenAI-compatible chat endpoints.
// The endpoint is configurable and the model is chosen per request, so the
// same client works against OpenAI, Claude/GPT/Wenxin via a OneAPI gateway,
// etc.

import type {ToolDef} from './tools';

// A tool/function call requested by the model.
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string; // Raw JSON string of the arguments.
}

export interface LlmMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  // Text content. May be empty for an assistant turn that only calls tools.
  readonly content: string;
  // Present on assistant turns that requested tool calls.
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  // Present on 'tool' turns: which call this result answers.
  readonly toolCallId?: string;
}

// One streamed event: either a text fragment or the (final) set of tool calls
// the model wants executed before it continues.
export interface LlmEvent {
  readonly textDelta?: string;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
}

export interface LlmClientOpts {
  readonly endpoint: string; // e.g. https://host/v1/chat/completions
  readonly apiKey: string;
  readonly systemPrompt: string;
}

// Accumulates streamed OpenAI tool_call fragments, keyed by their `index`.
interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

export class LlmClient {
  constructor(private readonly opts: LlmClientOpts) {}

  // Derives the `/v1/models` URL from the chat completions endpoint. Falls back
  // to appending '/models' to the origin if the path is non-standard.
  private modelsUrl(): string {
    const e = this.opts.endpoint;
    if (/\/chat\/completions\/?$/.test(e)) {
      return e.replace(/\/chat\/completions\/?$/, '/models');
    }
    try {
      const u = new URL(e);
      return `${u.origin}/v1/models`;
    } catch {
      return e;
    }
  }

  // Fetches the list of available model ids from the OpenAI-compatible
  // `/models` endpoint. Returns a sorted list; throws on HTTP error.
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await fetch(this.modelsUrl(), {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<no body>');
      throw new Error(`List models error ${resp.status}: ${text}`);
    }
    const json = (await resp.json()) as {
      readonly data?: ReadonlyArray<{readonly id?: string}>;
    };
    return (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .sort((a, b) => a.localeCompare(b));
  }

  // Sends a multi-turn conversation with the given model and yields streamed
  // events: text fragments as they arrive, and — if the model decides to call
  // tools — a final event carrying the accumulated tool calls. The configured
  // system prompt is prepended automatically.
  async *send(
    messages: ReadonlyArray<LlmMessage>,
    model: string,
    tools: ReadonlyArray<ToolDef> | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmEvent, void, void> {
    const resp = await fetch(this.opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {role: 'system', content: this.opts.systemPrompt},
          ...messages.map(serializeMessage),
        ],
        ...(tools && tools.length > 0 ? {tools, tool_choice: 'auto'} : {}),
      }),
      signal,
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '<no body>');
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Tool calls are streamed as fragments keyed by index; accumulate them.
    const partialCalls = new Map<number, PartialToolCall>();

    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      buf = buf.replace(/\r\n/g, '\n');

      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const payload = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('');
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            readonly choices?: ReadonlyArray<{
              readonly delta?: {
                readonly content?: string;
                readonly tool_calls?: ReadonlyArray<{
                  readonly index: number;
                  readonly id?: string;
                  readonly function?: {
                    readonly name?: string;
                    readonly arguments?: string;
                  };
                }>;
              };
            }>;
            readonly delta?: {readonly text?: string};
          };
          const delta = chunk.choices?.[0]?.delta;
          const text =
            delta?.content ??
            // Anthropic-compatible streaming gateways often use this shape.
            chunk.delta?.text ??
            '';
          if (text !== '') yield {textDelta: text};

          for (const tc of delta?.tool_calls ?? []) {
            const cur = partialCalls.get(tc.index) ?? {
              id: '',
              name: '',
              args: '',
            };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            partialCalls.set(tc.index, cur);
          }
        } catch {
          // Skip unparseable events
        }
      }
    }

    if (partialCalls.size > 0) {
      const calls: ToolCall[] = [...partialCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({id: c.id, name: c.name, arguments: c.args}));
      yield {toolCalls: calls};
    }
  }
}

// Translates our LlmMessage into the OpenAI wire shape.
function serializeMessage(m: LlmMessage): object {
  if (m.role === 'tool') {
    return {role: 'tool', tool_call_id: m.toolCallId, content: m.content};
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content === '' ? null : m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: {name: c.name, arguments: c.arguments},
      })),
    };
  }
  return {role: m.role, content: m.content};
}
