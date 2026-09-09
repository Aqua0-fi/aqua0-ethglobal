export type FetchLike = typeof fetch;

export type GraphClientConfig = {
  endpoint: string;
  authToken?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
};

export class GraphRequestError extends Error {
  readonly status: number | undefined;
  readonly graphErrors: unknown[] | undefined;

  constructor(message: string, options: { status?: number; graphErrors?: unknown[] } = {}) {
    super(message);
    this.name = "GraphRequestError";
    this.status = options.status;
    this.graphErrors = options.graphErrors;
  }
}

export type GraphResponse<T> = {
  data?: T;
  errors?: unknown[];
};

export class GraphClient {
  readonly #endpoint: string;
  readonly #authToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(config: GraphClientConfig) {
    const endpoint = config.endpoint.trim();
    if (endpoint.length === 0) {
      throw new Error("GRAPH_ENDPOINT is required");
    }

    this.#endpoint = endpoint;
    this.#authToken = config.authToken;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#fetch = config.fetch ?? fetch;
  }

  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json"
      };

      if (this.#authToken) {
        headers.authorization = `Bearer ${this.#authToken}`;
      }

      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: controller.signal
      });

      const text = await response.text();
      let body: GraphResponse<T>;
      try {
        body = text.length > 0 ? (JSON.parse(text) as GraphResponse<T>) : {};
      } catch {
        throw new GraphRequestError("Graph endpoint returned non-JSON response", {
          status: response.status
        });
      }

      if (!response.ok) {
        const errorOptions: { status?: number; graphErrors?: unknown[] } = {
          status: response.status
        };
        if (body.errors) {
          errorOptions.graphErrors = body.errors;
        }
        throw new GraphRequestError(`Graph HTTP error ${response.status}`, errorOptions);
      }

      if (body.errors && body.errors.length > 0) {
        throw new GraphRequestError("Graph query returned errors", {
          status: response.status,
          graphErrors: body.errors
        });
      }

      if (!("data" in body)) {
        throw new GraphRequestError("Graph response did not include data", {
          status: response.status
        });
      }

      return body.data as T;
    } catch (error) {
      if (error instanceof GraphRequestError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new GraphRequestError(`Graph query timed out after ${this.#timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : "Unknown Graph request failure";
      throw new GraphRequestError(`Graph request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeAddress(address: string): Lowercase<string> {
  const value = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  return value as Lowercase<string>;
}

export function normalizeBytes32(value: string): Lowercase<string> {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid bytes32 value: ${value}`);
  }
  return normalized as Lowercase<string>;
}

export function addBigIntStrings(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`Invalid BigInt string from Graph: ${value}`);
    }
    total += BigInt(value);
  }
  return total.toString();
}
