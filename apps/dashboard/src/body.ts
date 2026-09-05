import { type CreateStrategyInput } from "@aqua0/shared";

export const MAX_JSON_BODY_BYTES = 32 * 1024;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(
  chunks: AsyncIterable<Uint8Array>,
  options: {
    contentLength?: string | undefined;
    contentType?: string | undefined;
    maxBytes?: number;
  } = {}
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_JSON_BODY_BYTES;
  if (options.contentType && !isJsonContentType(options.contentType)) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  if (options.contentLength) {
    const parsedLength = Number(options.contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new ApiError(400, "bad_content_length", "Content-Length must be a valid byte count");
    }
    if (parsedLength > maxBytes) {
      throw new ApiError(413, "body_too_large", "JSON body must be 32KB or smaller");
    }
  }

  const buffers: Buffer[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ApiError(413, "body_too_large", "JSON body must be 32KB or smaller");
    }
    buffers.push(Buffer.from(chunk));
  }

  if (total === 0) {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }

  try {
    return JSON.parse(Buffer.concat(buffers, total).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export function parsePrepareStrategyInput(value: unknown): CreateStrategyInput {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_body", "Request JSON must be an object");
  }

  const strategist = readString(value, "strategist");
  const token0 = readString(value, "token0");
  const token1 = readString(value, "token1");
  const label = readString(value, "label").trim();
  if (label.length === 0) {
    throw new ApiError(400, "invalid_body", "label is required");
  }

  const vaultsValue = value.vaults;
  if (!Array.isArray(vaultsValue) || vaultsValue.length === 0) {
    throw new ApiError(400, "invalid_body", "vaults must be a non-empty string array");
  }
  if (vaultsValue.length > 8) {
    throw new ApiError(400, "invalid_body", "vaults may include at most 8 legs");
  }

  const vaults = vaultsValue.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ApiError(400, "invalid_body", `vaults[${index}] must be a non-empty string`);
    }
    return item.trim();
  });

  return {
    strategist,
    token0,
    token1,
    label,
    vaults
  };
}

function isJsonContentType(value: string): boolean {
  return value
    .split(";")[0]
    ?.trim()
    .toLowerCase() === "application/json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, field: string): string {
  const raw = value[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ApiError(400, "invalid_body", `${field} is required`);
  }
  return raw.trim();
}
