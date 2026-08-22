import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import * as yaml from "js-yaml";
import { OpenApiSpec } from "./types";

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

  return parseOpenApiContent(rawContent, source);
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
 * Resolve a $ref string to the actual schema within the spec.
 */
export function resolveRef(
  ref: string,
  spec: OpenApiSpec
): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) {
    return null;
  }
  const parts = ref.slice(2).split("/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    if (current === undefined || current === null) return null;
    current = current[part];
  }
  return current as Record<string, unknown> | null;
}
