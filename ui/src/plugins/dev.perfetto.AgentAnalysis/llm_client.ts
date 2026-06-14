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

export interface LlmChunk {
  readonly text: string;
}

export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmClientOpts {
  readonly endpoint: string; // e.g. https://host/v1/chat/completions
  readonly apiKey: string;
  readonly systemPrompt: string;
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

  // Sends a multi-turn conversation with the given model and yields
  // incremental text chunks. The configured system prompt is prepended
  // automatically.
  async *send(
    messages: ReadonlyArray<LlmMessage>,
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmChunk, void, void> {
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
          ...messages,
        ],
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
              readonly delta?: {readonly content?: string};
            }>;
            readonly delta?: {readonly text?: string};
          };
          const text =
            chunk.choices?.[0]?.delta?.content ??
            // Anthropic-compatible streaming gateways often use this shape.
            chunk.delta?.text ??
            '';
          if (text !== '') yield {text};
        } catch {
          // Skip unparseable events
        }
      }
    }
  }
}
