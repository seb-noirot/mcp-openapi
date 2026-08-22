import { AxiosInstance } from "axios";
import {
  McpToolDefinition,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSpec,
} from "./types";
import { buildInputSchema, extractRequestBodySchema } from "./generator";

/**
 * Execute an API call for an MCP tool invocation.
 */
export async function executeToolCall(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  httpClient: AxiosInstance,
  spec: OpenApiSpec
): Promise<unknown> {
  const startedAt = Date.now();
  const validation = validateAndCoerceArgs(tool, args, spec);
  if (validation.errors.length > 0) {
    throw new Error(
      JSON.stringify(
        {
          error: {
            category: "validation",
            code: "INVALID_TOOL_INPUT",
            message: "Tool input validation failed",
            details: validation.errors,
          },
        },
        null,
        2
      )
    );
  }
  const safeArgs = validation.coerced;
  let urlPath = tool.path;

  const queryParams: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  // Separate path, query, and header parameters
  for (const param of tool.parameters) {
    const value = safeArgs[param.name];
    if (value === undefined || value === null) continue;

    if (param.in === "path") {
      urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    } else if (param.in === "query") {
      queryParams[param.name] = value;
    } else if (param.in === "header") {
      headers[param.name] = String(value);
    }
    // cookie params are ignored for now
  }

  const body = safeArgs["body"];

  const response = await httpClient.request({
    method: tool.method,
    url: urlPath,
    params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    data: body !== undefined ? body : undefined,
    validateStatus: () => true, // Don't throw on non-2xx
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText,
    data: response.data,
    error:
      response.status >= 400
        ? {
            category: "http",
            code: `HTTP_${response.status}`,
            message: response.statusText || "HTTP error",
          }
        : undefined,
    meta: {
      durationMs: Date.now() - startedAt,
      requestId: String(response.headers?.["x-request-id"] ?? ""),
      retryCount: Number(
        (
          response.config as {
            __retryAttempt?: number;
          }
        ).__retryAttempt ?? 0
      ),
    },
  };
}

/**
 * Build the MCP tool input schema for a given tool definition.
 */
export function getToolInputSchema(
  tool: McpToolDefinition,
  spec: OpenApiSpec
): Record<string, unknown> {
  const requestBodySchema = extractRequestBodySchema(tool.requestBody, spec);
  return buildInputSchema(tool.parameters, requestBodySchema, spec);
}

/**
 * Filter only path and query parameters (excluding header/cookie for display).
 */
export function getVisibleParameters(
  parameters: OpenApiParameter[]
): OpenApiParameter[] {
  return parameters.filter((p) => p.in === "path" || p.in === "query");
}

interface ValidationResult {
  errors: string[];
  coerced: Record<string, unknown>;
}

function validateAndCoerceArgs(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  spec: OpenApiSpec
): ValidationResult {
  const errors: string[] = [];
  const coerced: Record<string, unknown> = { ...args };

  for (const param of tool.parameters) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) {
        errors.push(`Missing required parameter "${param.name}"`);
      }
      continue;
    }

    if (param.schema) {
      const paramErrors: string[] = [];
      const parsedValue = coerceValueBySchema(value, param.schema, `parameter "${param.name}"`, paramErrors, spec);
      if (paramErrors.length > 0) {
        errors.push(...paramErrors);
      } else {
        coerced[param.name] = parsedValue;
      }
    }
  }

  const requestBodySchema = extractRequestBodySchema(tool.requestBody, spec);
  if (tool.requestBody?.required && (args["body"] === undefined || args["body"] === null)) {
    errors.push('Missing required request body "body"');
  }
  if (args["body"] !== undefined && requestBodySchema) {
    const bodyErrors: string[] = [];
    const parsedBody = coerceValueBySchema(args["body"], requestBodySchema, "request body", bodyErrors, spec);
    if (bodyErrors.length > 0) {
      errors.push(...bodyErrors);
    } else {
      coerced["body"] = parsedBody;
    }
  }

  return { errors, coerced };
}

function coerceValueBySchema(
  value: unknown,
  schema: OpenApiSchema,
  label: string,
  errors: string[],
  spec: OpenApiSpec
): unknown {
  const resolved = resolveSchema(schema, spec);
  const schemaType = resolved.type;

  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${label} must be one of: ${resolved.enum.map(String).join(", ")}`);
    return value;
  }

  if (!schemaType) return value;
  if (schemaType === "integer") {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(num)) {
      errors.push(`${label} must be an integer`);
      return value;
    }
    if (resolved.minimum !== undefined && num < resolved.minimum) {
      errors.push(`${label} must be >= ${resolved.minimum}`);
    }
    if (resolved.maximum !== undefined && num > resolved.maximum) {
      errors.push(`${label} must be <= ${resolved.maximum}`);
    }
    return num;
  }
  if (schemaType === "number") {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(num)) {
      errors.push(`${label} must be a number`);
      return value;
    }
    if (resolved.minimum !== undefined && num < resolved.minimum) {
      errors.push(`${label} must be >= ${resolved.minimum}`);
    }
    if (resolved.maximum !== undefined && num > resolved.maximum) {
      errors.push(`${label} must be <= ${resolved.maximum}`);
    }
    return num;
  }
  if (schemaType === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    errors.push(`${label} must be a boolean`);
    return value;
  }
  if (schemaType === "string") {
    const str = String(value);
    if (resolved.minLength !== undefined && str.length < resolved.minLength) {
      errors.push(`${label} length must be >= ${resolved.minLength}`);
    }
    if (resolved.maxLength !== undefined && str.length > resolved.maxLength) {
      errors.push(`${label} length must be <= ${resolved.maxLength}`);
    }
    return str;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${label} must be an array`);
      return value;
    }
    if (!resolved.items) return value;
    return value.map((item, idx) =>
      coerceValueBySchema(item, resolved.items as OpenApiSchema, `${label}[${idx}]`, errors, spec)
    );
  }
  if (schemaType === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${label} must be an object`);
      return value;
    }
    const obj = value as Record<string, unknown>;
    const properties = resolved.properties ?? {};
    const required = new Set(resolved.required ?? []);
    for (const req of required) {
      if (obj[req] === undefined || obj[req] === null) {
        errors.push(`${label} is missing required property "${req}"`);
      }
    }
    const out: Record<string, unknown> = { ...obj };
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (obj[name] === undefined) continue;
      out[name] = coerceValueBySchema(obj[name], propertySchema, `${label}.${name}`, errors, spec);
    }
    return out;
  }

  return value;
}

function resolveSchema(schema: OpenApiSchema, spec: OpenApiSpec): OpenApiSchema {
  if (!schema.$ref) return schema;
  const ref = schema.$ref;
  if (!ref.startsWith("#/")) return schema;
  const parts = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return schema;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return (current as OpenApiSchema) ?? schema;
}
