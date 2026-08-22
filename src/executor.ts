import { AxiosInstance } from "axios";
import {
  McpToolDefinition,
  OpenApiParameter,
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
  let urlPath = tool.path;

  const queryParams: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  // Separate path, query, and header parameters
  for (const param of tool.parameters) {
    const value = args[param.name];
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

  const body = args["body"];

  const response = await httpClient.request({
    method: tool.method,
    url: urlPath,
    params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    data: body !== undefined ? body : undefined,
    validateStatus: () => true, // Don't throw on non-2xx
  });

  return {
    status: response.status,
    statusText: response.statusText,
    data: response.data,
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
