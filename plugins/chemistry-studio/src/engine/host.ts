/** The engine's only route out of its own process.
 *
 *  The built-in called the application's AI client and `fetch` directly. A package has
 *  neither: it is given a host proxy whose every method is gated by what the capability
 *  manifest declared. Binding it once here keeps that boundary in one file instead of
 *  threaded through the chemistry modules. */

export interface CapabilityHost {
  network: { fetch(endpointId: string, request: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> };
  model: { complete(request: { system?: string; prompt: string; maxTokens?: number }): Promise<string> };
  svg: { validate(svg: string): Promise<{ ok: boolean; errors: string[] }>; inspect(svg: string): Promise<{ width?: number; height?: number; elements: number }>; refine(request: { svg: string; instruction: string }): Promise<string> };
  subworker: { run(request: { entry: string; input: unknown; timeoutMs: number }): Promise<unknown> };
  attachments: { store(request: { bytes: Uint8Array; name: string; mimeType: string }): Promise<{ attachmentId: string; bytes: number }> };
  storage: { state: KeyValue; cache: KeyValue; temp: { dir(): Promise<string>; clear(): Promise<void> } };
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: Record<string, string | number | boolean>): void;
  readonly signal: AbortSignal;
}

interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

let current: CapabilityHost | null = null;

export function bindHost(host: CapabilityHost): void { current = host; }

export function host(): CapabilityHost {
  if (!current) throw new Error('The chemistry engine was used before its host was bound.');
  return current;
}

/** Stands in for the application's `completeText`. The model, its provider and the budget
 *  belong to the conversation, so the package asks for a completion and gets one or not. */
export async function completeText(options: {
  system?: string; user: string; maxTokens?: number;
  // Sampling hints the engine carried over from the application's own client. The host
  // decides these now — it owns the model and the budget — so they are accepted and
  // deliberately not forwarded, rather than made into a lie the package cannot keep.
  temperature?: number; reasoning?: string; plainContext?: boolean; signal?: AbortSignal;
}): Promise<string> {
  return host().model.complete({ system: options.system, prompt: options.user, maxTokens: options.maxTokens });
}

/** Stands in for `fetch`. Only the endpoints the manifest declared can be named. */
export async function fetchEndpoint(endpointId: string, path: string): Promise<{ status: number; text: string }> {
  const response = await host().network.fetch(endpointId, { path, method: 'GET' });
  return { status: response.status, text: Buffer.from(response.body).toString('utf8') };
}
