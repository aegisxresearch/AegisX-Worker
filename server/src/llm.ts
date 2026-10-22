export interface LlmSettings {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as sent by the provider. */
  arguments: string;
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Images the model should look at, as data URLs. Kept beside `content` rather
   * than inside it so every existing caller keeps working; the wire format
   * turns this into an OpenAI content-part array.
   */
  images?: string[];
  /** Native tool calls requested by the assistant turn. */
  toolCalls?: LlmToolCall[];
  /** Set on `tool` messages to link the result back to its call. */
  toolCallId?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class LlmError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

/**
 * True when the request failed because of the *model choice* rather than the
 * prompt: no credit, model not exposed, quota exceeded, or access denied.
 * Those are the only failures where retrying on another model makes sense.
 */
export function isModelUnavailableError(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  if ([402, 403, 404, 429].includes(error.status)) return true;
  if (error.status !== 400) return false;
  return /credit|balance|quota|not\s*found|unavailable|insufficient|no access|not\s*allowed/i.test(
    error.message,
  );
}

/**
 * True for failures worth one more identical attempt: the endpoint hiccuped
 * rather than rejecting the request. A 4xx is a statement about the request, so
 * retrying it would only spend tokens on the same answer; 5xx, 408 and a broken
 * socket are transient. 429 is excluded on purpose — it is handled by the model
 * fallback, which changes the model instead of repeating the same call.
 */
export function isTransientModelError(error: unknown): boolean {
  if (error instanceof LlmError) return error.status >= 500 || error.status === 408;
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return false;
  if (error.name === 'TimeoutError' || error.name === 'TypeError') return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|fetch failed/i.test(
    error.message,
  );
}

/** True when the endpoint rejected the `tools` payload rather than the prompt. */
export function isToolSupportError(error: unknown): boolean {
  if (!(error instanceof LlmError) || error.status !== 400) return false;
  return /tool|function[_ ]?call/i.test(error.message);
}

function joinUrl(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}${path}`;
}

function authHeaders(settings: LlmSettings): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey}`,
  };
}

async function readError(response: Response): Promise<LlmError> {
  let message = `HTTP ${response.status}`;
  let code = 'http_error';
  try {
    const raw = (await response.text()).slice(0, 600);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const errorNode = (parsed as { error?: unknown }).error;
      if (typeof errorNode === 'object' && errorNode !== null) {
        const messageNode = (errorNode as { message?: unknown }).message;
        const codeNode = (errorNode as { code?: unknown }).code;
        if (typeof messageNode === 'string') message = messageNode;
        if (typeof codeNode === 'string') code = codeNode;
      }
    }
  } catch {
    /* keep the HTTP fallback message */
  }
  return new LlmError(message, response.status, code);
}

/** Lists model ids exposed by the configured OpenAI-compatible endpoint. */
export async function listModels(settings: LlmSettings): Promise<string[]> {
  const response = await fetch(joinUrl(settings.endpoint, '/models'), {
    headers: authHeaders(settings),
  });
  if (!response.ok) throw await readError(response);
  const payload: unknown = await response.json();
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string')
    .sort((left, right) => left.localeCompare(right));
}

export interface ChatResult {
  content: string;
  usage: LlmUsage;
  toolCalls: LlmToolCall[];
}

function readUsage(payload: unknown): LlmUsage {
  const usageNode = (payload as { usage?: unknown }).usage;
  if (typeof usageNode !== 'object' || usageNode === null) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const usage = usageNode as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** Reads `message.tool_calls` from a non-streaming response. */
function readToolCalls(payload: unknown): LlmToolCall[] {
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const calls = (first as { message?: { tool_calls?: unknown } } | undefined)?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  const toolCalls: LlmToolCall[] = [];
  for (const entry of calls) {
    if (typeof entry !== 'object' || entry === null) continue;
    const node = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = node.function?.name;
    if (typeof name !== 'string') continue;
    const rawArgs = node.function?.arguments;
    toolCalls.push({
      id: typeof node.id === 'string' ? node.id : `call_${toolCalls.length}`,
      name,
      arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
    });
  }
  return toolCalls;
}

/** Converts the internal message list into the OpenAI wire format. */
export function serializeMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      };
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (message.images && message.images.length > 0) {
      return {
        role: message.role,
        content: [
          ...(message.content.length > 0 ? [{ type: 'text', text: message.content }] : []),
          ...message.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

function completionBody(
  settings: LlmSettings,
  messages: LlmMessage[],
  stream: boolean,
  tools?: LlmTool[],
): string {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: serializeMessages(messages),
    stream,
    temperature: 0.4,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (stream) body.stream_options = { include_usage: true };
  return JSON.stringify(body);
}

/** Single-shot chat completion. */
export async function chat(
  settings: LlmSettings,
  messages: LlmMessage[],
  signal?: AbortSignal,
  tools?: LlmTool[],
): Promise<ChatResult> {
  const response = await fetch(joinUrl(settings.endpoint, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(settings),
    body: completionBody(settings, messages, false, tools),
    signal,
  });
  if (!response.ok) throw await readError(response);
  const payload: unknown = await response.json();
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = (first as { message?: { content?: unknown } } | undefined)?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  return { content, usage: readUsage(payload), toolCalls: readToolCalls(payload) };
}

export interface StreamChunk {
  delta: string;
  usage?: LlmUsage;
  /** Present on the final chunk when the model requested native tool calls. */
  toolCalls?: LlmToolCall[];
}

/**
 * Streams a chat completion as text deltas.
 * The provider protocol is OpenAI-compatible: `data: {"choices":[{"delta":{"content":"..."}}]}`.
 * Native tool calls are accumulated from the deltas and emitted at the end.
 */
export async function* streamChat(
  settings: LlmSettings,
  messages: LlmMessage[],
  signal?: AbortSignal,
  tools?: LlmTool[],
): AsyncGenerator<StreamChunk> {
  const response = await fetch(joinUrl(settings.endpoint, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(settings),
    body: completionBody(settings, messages, true, tools),
    signal,
  });
  if (!response.ok) throw await readError(response);
  if (!response.body) throw new LlmError('Streaming is not supported by the endpoint', 500, 'no_body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pendingCalls = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choices = (parsed as { choices?: unknown }).choices;
        const first = Array.isArray(choices) ? choices[0] : undefined;
        const delta = (first as { delta?: { content?: unknown } } | undefined)?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield { delta };
        }
        const rawCalls = (first as { delta?: { tool_calls?: unknown } } | undefined)?.delta?.tool_calls;
        if (Array.isArray(rawCalls)) {
          for (const entry of rawCalls) {
            if (typeof entry !== 'object' || entry === null) continue;
            const node = entry as {
              index?: unknown;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            };
            const index = typeof node.index === 'number' ? node.index : pendingCalls.size;
            const current = pendingCalls.get(index) ?? { id: '', name: '', args: '' };
            if (typeof node.id === 'string' && node.id.length > 0) current.id = node.id;
            if (typeof node.function?.name === 'string') current.name = node.function.name;
            if (typeof node.function?.arguments === 'string') current.args += node.function.arguments;
            pendingCalls.set(index, current);
          }
        }
        const usage = readUsage(parsed);
        if (usage.totalTokens > 0) {
          yield { delta: '', usage };
        }
      }
    }
  }

  if (pendingCalls.size > 0) {
    const toolCalls: LlmToolCall[] = [...pendingCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, call]) => ({
        id: call.id.length > 0 ? call.id : `call_${index}`,
        name: call.name,
        arguments: call.args.length > 0 ? call.args : '{}',
      }))
      .filter((call) => call.name.length > 0);
    if (toolCalls.length > 0) yield { delta: '', toolCalls };
  }
}
