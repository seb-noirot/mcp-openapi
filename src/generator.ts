import {
  FilterRule,
  McpToolDefinition,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSpec,
} from "./types";
import { resolveRef } from "./loader";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function normalizeToolPrefix(prefix: string | undefined): string {
  if (!prefix) {
    return "";
  }

  const normalized = normalizeNameSegment(prefix);

  return normalized ? `${normalized}_` : "";
}

/**
 * Generate an MCP tool name from an operationId or method+path combination.
 */
export function generateToolName(
  method: string,
  path: string,
  operationId?: string
): string {
  if (operationId) {
    // Convert operationId to snake_case tool name
    return normalizeNameSegment(operationId);
  }

  // Fallback: method + path - extract path param names and normalize
  const pathPart = extractPathSegments(path)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_|_$/g, "");

  return `${method.toLowerCase()}_${pathPart}`;
}

function normalizeNameSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Replace path parameter placeholders like {petId} with just the param name (petId).
 * Uses a simple character-by-character scan to avoid ReDoS-prone regex.
 */
function extractPathSegments(path: string): string {
  let result = "";
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === "{") {
      const end = path.indexOf("}", i);
      if (end === -1) {
        result += path.slice(i);
        break;
      }
      result += path.slice(i + 1, end);
      i = end + 1;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

/**
 * Build a human-readable description for a tool.
 */
export function buildToolDescription(
  method: string,
  path: string,
  summary?: string,
  description?: string,
  tags?: string[]
): string {
  const parts: string[] = [];

  if (summary) {
    parts.push(summary);
  }

  if (description && description !== summary) {
    parts.push(description);
  }

  if (!summary && !description) {
    parts.push(`${method.toUpperCase()} ${path}`);
  }

  if (tags && tags.length > 0) {
    parts.push(`Tags: ${tags.join(", ")}`);
  }

  return parts.join("\n\n");
}

/**
 * Convert an OpenAPI schema to a JSON Schema object suitable for MCP tool input.
 */
export function schemaToJsonSchema(
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec
): Record<string, unknown> {
  if (!schema) return { type: "object" };

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec) as OpenApiSchema | null;
    if (resolved) {
      return schemaToJsonSchema(resolved, spec);
    }
    return {};
  }

  const result: Record<string, unknown> = {};

  if (schema.type) result["type"] = schema.type;
  if (schema.description) result["description"] = schema.description;
  if (schema.enum) result["enum"] = schema.enum;
  if (schema.format) result["format"] = schema.format;
  if (schema.minimum !== undefined) result["minimum"] = schema.minimum;
  if (schema.maximum !== undefined) result["maximum"] = schema.maximum;
  if (schema.minLength !== undefined) result["minLength"] = schema.minLength;
  if (schema.maxLength !== undefined) result["maxLength"] = schema.maxLength;
  if (schema.default !== undefined) result["default"] = schema.default;
  if (schema.example !== undefined) result["example"] = schema.example;

  if (schema.items) {
    result["items"] = schemaToJsonSchema(schema.items, spec);
  }

  if (schema.properties) {
    result["properties"] = Object.fromEntries(
      Object.entries(schema.properties).map(([key, val]) => [
        key,
        schemaToJsonSchema(val, spec),
      ])
    );
    if (schema.required) {
      result["required"] = schema.required;
    }
  }

  if (schema.allOf) {
    result["allOf"] = schema.allOf.map((s) => schemaToJsonSchema(s, spec));
  }
  if (schema.oneOf) {
    result["oneOf"] = schema.oneOf.map((s) => schemaToJsonSchema(s, spec));
  }
  if (schema.anyOf) {
    result["anyOf"] = schema.anyOf.map((s) => schemaToJsonSchema(s, spec));
  }

  return result;
}

/**
 * Build the JSON Schema for MCP tool inputSchema from operation parameters and request body.
 */
export function buildInputSchema(
  parameters: OpenApiParameter[],
  requestBodySchema: OpenApiSchema | undefined,
  spec: OpenApiSpec
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    const schema = param.schema ? schemaToJsonSchema(param.schema, spec) : { type: "string" };
    properties[param.name] = {
      ...schema,
      description: param.description ?? (schema as Record<string, unknown>)["description"],
    };
    if (param.required) {
      required.push(param.name);
    }
  }

  if (requestBodySchema) {
    properties["body"] = {
      ...schemaToJsonSchema(requestBodySchema, spec),
      description: "Request body",
    };
    // Request body required is handled by the operation, default to not required
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Extract the JSON schema from a request body definition (prefers application/json).
 */
export function extractRequestBodySchema(
  requestBody: McpToolDefinition["requestBody"],
  spec: OpenApiSpec
): OpenApiSchema | undefined {
  if (!requestBody?.content) return undefined;

  const jsonContent =
    requestBody.content["application/json"] ??
    requestBody.content["application/x-www-form-urlencoded"] ??
    Object.values(requestBody.content)[0];

  if (!jsonContent?.schema) return undefined;

  if (jsonContent.schema.$ref) {
    return (resolveRef(jsonContent.schema.$ref, spec) as OpenApiSchema | null) ?? jsonContent.schema;
  }

  return jsonContent.schema;
}

/**
 * Generate all MCP tool definitions from an OpenAPI spec.
 */
export function generateTools(
  spec: OpenApiSpec,
  toolPrefix?: string,
  include?: FilterRule[],
  exclude?: FilterRule[]
): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  const usedNames = new Set<string>();
  const normalizedPrefix = normalizeToolPrefix(toolPrefix);

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const pathLevelParameters = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method as keyof typeof pathItem];
      if (!operation || typeof operation !== "object") continue;

      const op = operation as import("./types").OpenApiOperation;
      if (op.deprecated) continue;

      // Apply include/exclude filters
      if (!matchesFilter(method, path, op.operationId, op.tags, include, exclude)) {
        continue;
      }

      const allParameters = [
        ...pathLevelParameters,
        ...(op.parameters ?? []),
      ];

      let name = `${normalizedPrefix}${generateToolName(method, path, op.operationId)}`;

      // Deduplicate names
      if (usedNames.has(name)) {
        let i = 2;
        while (usedNames.has(`${name}_${i}`)) i++;
        name = `${name}_${i}`;
      }
      usedNames.add(name);

      const description = buildToolDescription(
        method,
        path,
        op.summary,
        op.description,
        op.tags
      );

      tools.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId ?? name,
        name,
        description,
        parameters: allParameters,
        requestBody: op.requestBody,
        tags: op.tags,
      });
    }
  }

  return tools;
}

/**
 * Return true if the operation should be included given include/exclude rules.
 *
 * - include rules: at least one rule must match (if any rules are specified).
 * - exclude rules: none of the rules may match.
 * A rule matches if ALL of the specified fields match (tag, method, operationId are ANDed).
 */
function matchesFilter(
  method: string,
  _path: string,
  operationId: string | undefined,
  tags: string[] | undefined,
  include: FilterRule[] | undefined,
  exclude: FilterRule[] | undefined
): boolean {
  const upperMethod = method.toUpperCase();
  const lowerTags = (tags ?? []).map((t) => t.toLowerCase());

  const ruleMatches = (rule: FilterRule): boolean => {
    if (rule.method && rule.method.toUpperCase() !== upperMethod) return false;
    if (rule.operationId && rule.operationId !== operationId) return false;
    if (rule.tag && !lowerTags.includes(rule.tag.toLowerCase())) return false;
    return true;
  };

  if (include && include.length > 0) {
    if (!include.some(ruleMatches)) return false;
  }

  if (exclude && exclude.length > 0) {
    if (exclude.some(ruleMatches)) return false;
  }

  return true;
}
