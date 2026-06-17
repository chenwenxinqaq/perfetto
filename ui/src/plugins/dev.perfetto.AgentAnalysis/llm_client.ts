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
  // Required by the Anthropic /messages protocol; ignored by OpenAI. Defaults
  // to 4096 when unset.
  readonly maxTokens?: number;
}

// Accumulates streamed OpenAI tool_call fragments, keyed by their `index`.
interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

export class LlmClient {
  constructor(private readonly opts: LlmClientOpts) {}

  // The configured system prompt, exposed so the agent log can record exactly
  // what instructions the model was given each round.
  get systemPrompt(): string {
    return this.opts.systemPrompt;
  }

  // This gateway (and Anthropic generally) serves Claude models via the
  // /messages protocol, NOT OpenAI's /chat/completions — sending a Claude id to
  // /chat/completions 404s upstream. Route by model name: Claude family always
  // goes through /messages, plus a few non-Claude models that the Baidu OneAPI
  // gateway also serves over /v1/messages (and which only support tool_use via
  // that protocol).
  private isAnthropicModel(model: string): boolean {
    const m = model.trim().toLowerCase();
    if (
      m.startsWith('claude') ||
      m.includes('opus') ||
      m.includes('sonnet') ||
      m.includes('haiku')
    ) {
      return true;
    }
    return m.includes('minimax') || m.includes('kimi') || m.includes('glm');
  }

  // Derives the Anthropic /messages URL from the configured chat endpoint
  // (…/chat/completions -> …/messages, else …/v1/messages off the origin).
  private messagesUrl(): string {
    const e = this.opts.endpoint;
    if (/\/chat\/completions\/?$/.test(e)) {
      return e.replace(/\/chat\/completions\/?$/, '/messages');
    }
    try {
      const u = new URL(e);
      return `${u.origin}/v1/messages`;
    } catch {
      return e;
    }
  }

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
    if (this.isAnthropicModel(model)) {
      yield* this.sendAnthropic(messages, model, tools, signal);
      return;
    }
    yield* this.sendOpenAI(messages, model, tools, signal);
  }

  // OpenAI-compatible /chat/completions streaming.
  private async *sendOpenAI(
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

  // Anthropic /messages streaming. The wire shapes differ from OpenAI: system
  // is a top-level field, messages carry content blocks (text / tool_use /
  // tool_result), tools use input_schema, and the SSE events are
  // content_block_* / message_* rather than choices[].delta.
  private async *sendAnthropic(
    messages: ReadonlyArray<LlmMessage>,
    model: string,
    tools: ReadonlyArray<ToolDef> | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmEvent, void, void> {
    const body: Record<string, unknown> = {
      model,
      stream: true,
      max_tokens: this.opts.maxTokens ?? 4096,
      // Anthropic accepts `system` either as a plain string or as an array of
      // text blocks. We use the array form so the last block can carry
      // `cache_control: ephemeral`, which makes the gateway cache the stable
      // prefix (system prompt + tool definitions) across turns. Multi-turn
      // agent loops with the same toolset see large cache_read hit rates.
      system: [
        {
          type: 'text',
          text: this.opts.systemPrompt,
          cache_control: {type: 'ephemeral'},
        },
      ],
      messages: toAnthropicMessages(messages),
    };
    if (tools && tools.length > 0) {
      const toolDefs = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })) as Array<Record<string, unknown>>;
      // Cache the prefix through the end of the tool list too. A cache_control
      // marker caches everything up to and including the marker, so placing it
      // on the last tool subsumes the system marker above on the gateway.
      toolDefs[toolDefs.length - 1].cache_control = {type: 'ephemeral'};
      body.tools = toolDefs;
    }
    const resp = await fetch(this.messagesUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.opts.apiKey}`,
        // Required by Anthropic's API and accepted by OneAPI-style gateways.
        // Without this header, direct calls to api.anthropic.com 400.
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '<no body>');
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Anthropic streams one content block at a time, keyed by index. A
    // tool_use block carries id/name up front, then its JSON args arrive as
    // input_json_delta fragments we concatenate.
    const toolBlocks = new Map<
      number,
      {id: string; name: string; args: string}
    >();

    // Per-chunk SSE timeout: if the gateway stops sending data mid-stream
    // (network stall, upstream hang), reader.read() would otherwise wait
    // forever. Race each read against a 30s timer and abort if it loses.
    const CHUNK_TIMEOUT_MS = 30_000;

    for (;;) {
      const readPromise = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`SSE chunk timeout: no data for ${CHUNK_TIMEOUT_MS}ms`),
            ),
          CHUNK_TIMEOUT_MS,
        );
      });

      let value: Uint8Array | undefined;
      let done = false;
      try {
        const r = await Promise.race([readPromise, timeoutPromise]);
        value = r.value;
        done = r.done;
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
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
            readonly type?: string;
            readonly index?: number;
            readonly content_block?: {
              readonly type?: string;
              readonly id?: string;
              readonly name?: string;
              readonly text?: string;
            };
            readonly delta?: {
              readonly type?: string;
              readonly text?: string;
              readonly partial_json?: string;
            };
          };
          switch (chunk.type) {
            case 'content_block_start': {
              const cb = chunk.content_block;
              if (cb?.type === 'tool_use' && chunk.index !== undefined) {
                toolBlocks.set(chunk.index, {
                  id: cb.id ?? '',
                  name: cb.name ?? '',
                  args: '',
                });
              } else if (cb?.type === 'text' && cb.text) {
                yield {textDelta: cb.text};
              }
              break;
            }
            case 'content_block_delta': {
              const d = chunk.delta;
              if (d?.type === 'text_delta' && d.text) {
                yield {textDelta: d.text};
              } else if (
                d?.type === 'input_json_delta' &&
                d.partial_json !== undefined &&
                // Some gateways emit the literal string "null" as a stray
                // fragment between real JSON deltas; concatenating it would
                // corrupt the accumulated arguments.
                d.partial_json !== 'null' &&
                chunk.index !== undefined
              ) {
                const blk = toolBlocks.get(chunk.index);
                if (blk !== undefined) blk.args += d.partial_json;
              }
              break;
            }
            default:
              break; // message_start / ping / *_stop / message_delta: ignore.
          }
        } catch {
          // Skip unparseable events.
        }
      }
    }

    if (toolBlocks.size > 0) {
      const calls: ToolCall[] = [...toolBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({
          id: c.id,
          name: c.name,
          arguments: c.args === '' ? '{}' : c.args,
        }));
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

// Translates our flat LlmMessage list into Anthropic /messages content-block
// shape. Anthropic has no 'tool' role: a tool result is a user message whose
// content is a tool_result block, and an assistant tool call is a tool_use
// block. Consecutive tool results are merged into one user message so they sit
// after the assistant's tool_use turn (Anthropic requires that ordering).
function toAnthropicMessages(
  messages: ReadonlyArray<LlmMessage>,
): Array<{role: string; content: unknown}> {
  const out: Array<{role: string; content: unknown}> = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      const last = out[out.length - 1];
      if (
        last !== undefined &&
        last.role === 'user' &&
        Array.isArray(last.content)
      ) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({role: 'user', content: [block]});
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: unknown[] = [];
      if (m.content !== '') content.push({type: 'text', text: m.content});
      for (const c of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({type: 'tool_use', id: c.id, name: c.name, input});
      }
      out.push({role: 'assistant', content});
      continue;
    }
    // Plain user/assistant text message.
    out.push({role: m.role, content: m.content});
  }
  return out;
}
