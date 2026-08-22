import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { AuthConfig, DefinedServerConfig, EnvConfig, ServerConfig } from "./types";

interface RawServerConfigFile {
  openApiPath?: string;
  serverIndex?: number;
  toolPrefix?: string;
  auth?: AuthConfig;
  servers?: Array<string | DefinedServerConfig>;
  envs?: Record<string, EnvConfig>;
  env?: string;
}

export function loadConfigFile(configPath: string, envOverride?: string): Partial<ServerConfig> {
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
  const rawContent = fs.readFileSync(absolutePath, "utf-8");
  const config = parseConfigContent(rawContent, absolutePath);
  const configDir = path.dirname(absolutePath);

  const envResult = resolveEnvConfig(config.envs, envOverride ?? config.env);

  return {
    openApiPath: resolveConfigOpenApiPath(config.openApiPath, configDir),
    serverIndex: config.serverIndex,
    toolPrefix: config.toolPrefix,
    auth: envResult?.auth ?? config.auth,
    servers: envResult?.servers ?? normalizeDefinedServers(config.servers),
  };
}

function resolveEnvConfig(
  envs: Record<string, EnvConfig> | undefined,
  envName: string | undefined
): { auth?: AuthConfig; servers?: DefinedServerConfig[] } | undefined {
  if (!envs || Object.keys(envs).length === 0) {
    return undefined;
  }

  const name = envName ?? Object.keys(envs)[0];
  const entry = envs[name];
  if (!entry) {
    throw new Error(`Environment "${name}" not found in config. Available: ${Object.keys(envs).join(", ")}`);
  }

  const auth = buildAuthFromEnvConfig(entry);

  return {
    auth,
    servers: [{ url: entry.url, ...(auth ? { auth } : {}) }],
  };
}

function buildAuthFromEnvConfig(entry: EnvConfig): AuthConfig | undefined {
  const authType = entry.authType;
  if (!authType || authType === "none") {
    return authType === "none" ? { type: "none" } : undefined;
  }

  if (authType === "bearer") {
    return { type: "bearer", ...(entry.token ? { token: entry.token } : {}) };
  }

  if (authType === "basic") {
    return {
      type: "basic",
      ...(entry.username ? { username: entry.username } : {}),
      ...(entry.password ? { password: entry.password } : {}),
    };
  }

  if (authType === "apikey") {
    return {
      type: "apikey",
      ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
      ...(entry.apiKeyHeader ? { apiKeyHeader: entry.apiKeyHeader } : {}),
      ...(entry.apiKeyQueryParam ? { apiKeyQueryParam: entry.apiKeyQueryParam } : {}),
    };
  }

  return undefined;
}

function parseConfigContent(content: string, source: string): RawServerConfigFile {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(content) as RawServerConfigFile;
    } catch {
      throw new Error(`Failed to parse config file ${source}: not valid JSON`);
    }
  }

  try {
    return yaml.load(content) as RawServerConfigFile;
  } catch {
    throw new Error(`Failed to parse config file ${source}: not valid JSON or YAML`);
  }
}

function resolveConfigOpenApiPath(
  openApiPath: string | undefined,
  configDir: string
): string | undefined {
  if (!openApiPath) {
    return undefined;
  }

  if (
    openApiPath.startsWith("http://") ||
    openApiPath.startsWith("https://") ||
    path.isAbsolute(openApiPath)
  ) {
    return openApiPath;
  }

  return path.resolve(configDir, openApiPath);
}

function normalizeDefinedServers(
  servers: Array<string | DefinedServerConfig> | undefined
): DefinedServerConfig[] | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }

  return servers.map((server) =>
    typeof server === "string"
      ? { url: server }
      : {
          url: server.url,
          ...(server.name ? { name: server.name } : {}),
          ...(server.description ? { description: server.description } : {}),
          ...(server.auth ? { auth: server.auth } : {}),
        }
  );
}
