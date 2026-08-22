import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import * as yaml from "js-yaml";
import { OpenApiSpec, OpenApiServer } from "./types";

/**
 * Load an OpenAPI specification from a file path or URL.
 */
export async function loadOpenApiSpec(source: string): Promise<OpenApiSpec> {
  let rawContent: string;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await axios.get<string>(source, {
      responseType: "text",
      headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
    });
    rawContent = response.data;
  } else {
    const absolutePath = path.isAbsolute(source)
      ? source
      : path.resolve(process.cwd(), source);
    rawContent = fs.readFileSync(absolutePath, "utf-8");
  }

  const parsed = parseOpenApiContent(rawContent, source);
  return normalizeSpec(parsed);
}

function parseOpenApiContent(content: string, source: string): OpenApiSpec {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(content) as OpenApiSpec;
    } catch {
      throw new Error(`Failed to parse OpenAPI spec from ${source}: not valid JSON`);
    }
  }

  // Try YAML
  try {
    const parsed = yaml.load(content);
    return parsed as OpenApiSpec;
  } catch {
    throw new Error(`Failed to parse OpenAPI spec from ${source}: not valid JSON or YAML`);
  }
}

/**
 * Normalise a raw parsed spec:
 * - Converts Swagger 2.x to the OpenAPI 3.x server/path shape used internally.
 * - Resolves server URL {variable} templates to their default values.
 */
function normalizeSpec(raw: OpenApiSpec): OpenApiSpec {
  let spec = raw;

  // Swagger 2.x → OpenAPI 3.x normalisation
  if (!spec.openapi && spec.swagger) {
    spec = normalizeSwagger2(spec);
  }

  // Resolve server URL variable templates
  if (spec.servers) {
    spec = {
      ...spec,
      servers: spec.servers.map((server) => resolveServerVariables(server)),
    };
  }

  return spec;
}

/**
 * Normalise a Swagger 2.x spec into the OpenAPI 3.x shape used by the rest of the code.
 *
 * Only the fields needed by this tool are mapped; full Swagger 2.x compatibility is
 * intentionally out of scope.
 */
function normalizeSwagger2(raw: OpenApiSpec): OpenApiSpec {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = raw as any;

  // Build servers array from host / basePath / schemes
  const scheme: string = (s.schemes?.[0] as string | undefined) ?? "https";
  const host: string = (s.host as string | undefined) ?? "localhost";
  const basePath: string = (s.basePath as string | undefined) ?? "/";
  const serverUrl = `${scheme}://${host}${basePath === "/" ? "" : basePath}`;

  const servers: OpenApiServer[] = [{ url: serverUrl }];

  // Map Swagger 2.x path operations – consumes/produces are stripped but the
  // parameters and requestBody are normalised so the generator can use them.
  const paths: OpenApiSpec["paths"] = {};
  for (const [urlPath, pathItem] of Object.entries(s.paths ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi = pathItem as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalizedPathItem: any = {};
    if (pi.parameters) normalizedPathItem.parameters = pi.parameters;

    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = pi[method];
      if (!op) continue;

      // Convert body parameter → requestBody
      const bodyParam = (op.parameters ?? []).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => p.in === "body"
      );
      const nonBodyParams = (op.parameters ?? []).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => p.in !== "body"
      );

      const normalizedOp: Record<string, unknown> = {
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: op.tags,
        deprecated: op.deprecated,
        parameters: nonBodyParams,
        responses: op.responses ?? {},
        security: op.security,
      };

      if (bodyParam) {
        normalizedOp["requestBody"] = {
          description: bodyParam.description,
          required: bodyParam.required ?? false,
          content: {
            "application/json": {
              schema: bodyParam.schema ?? {},
            },
          },
        };
      }

      normalizedPathItem[method] = normalizedOp;
    }
    paths[urlPath] = normalizedPathItem;
  }

  return {
    openapi: "2.x-normalised",
    info: s.info ?? { title: "Unknown", version: "0" },
    servers,
    paths,
    components: s.definitions
      ? { schemas: s.definitions as NonNullable<OpenApiSpec["components"]>["schemas"] }
      : undefined,
    security: s.security,
  };
}

/**
 * Resolve OpenAPI 3.x server URL variable templates — e.g.
 * `https://{env}.api.example.com/{basePath}` → `https://production.api.example.com/v2`
 * using the `default` value of each variable.
 */
export function resolveServerVariables(server: OpenApiServer): OpenApiServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const variables = (server as any).variables as
    | Record<string, { default?: string; enum?: string[] }>
    | undefined;

  if (!variables || !server.url.includes("{")) {
    return server;
  }

  const resolvedUrl = server.url.replace(/\{([^}]+)\}/g, (_, name: string) => {
    return variables[name]?.default ?? name;
  });

  return { ...server, url: resolvedUrl };
}

/**
 * Resolve a $ref string to the actual schema within the spec.
 * Handles nested $refs recursively up to a depth limit to prevent infinite loops.
 */
export function resolveRef(
  ref: string,
  spec: OpenApiSpec,
  _visited?: Set<string>
): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) {
    return null;
  }

  const visited = _visited ?? new Set<string>();
  if (visited.has(ref)) {
    return null; // circular reference guard
  }
  visited.add(ref);

  const parts = ref.slice(2).split("/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    if (current === undefined || current === null) return null;
    current = current[part];
  }

  // If the resolved value itself has a $ref, follow it
  if (current && typeof current === "object" && "$ref" in current) {
    return resolveRef(current["$ref"] as string, spec, visited);
  }

  return current as Record<string, unknown> | null;
}
