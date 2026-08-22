import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { AuthConfig, DefinedServerConfig, EnvConfig, FilterRule, ServerConfig } from "./types";

interface RawServerConfigFile {
  openApiPath?: string;
  serverIndex?: number;
  toolPrefix?: string;
  auth?: AuthConfig;
  servers?: Array<string | DefinedServerConfig>;
  envs?: Record<string, EnvConfig>;
  env?: string;
  include?: FilterRule[];
  exclude?: FilterRule[];
  maxResponseBodyBytes?: number;
  timeout?: number;
  retries?: number;
  retryOn?: number[];
  specDriftCheckIntervalMs?: number;
  paginationMaxPages?: number;
  observability?: {
    debug?: boolean;
    includeRequestId?: boolean;
  };
  safety?: ServerConfig["safety"];
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
    openApiPath: resolveConfigOpenApiPath(
      interpolateEnvVars(config.openApiPath),
      configDir
    ),
    serverIndex: config.serverIndex,
    toolPrefix: config.toolPrefix,
    auth: envResult?.auth ?? interpolateAuth(config.auth),
    servers: envResult?.servers ?? normalizeDefinedServers(config.servers),
    include: config.include,
    exclude: config.exclude,
    maxResponseBodyBytes: config.maxResponseBodyBytes,
    timeout: envResult?.timeout ?? config.timeout,
    retries: envResult?.retries ?? config.retries,
    retryOn: envResult?.retryOn ?? config.retryOn,
    specDriftCheckIntervalMs: config.specDriftCheckIntervalMs,
    paginationMaxPages: config.paginationMaxPages,
    observability: config.observability,
    safety: config.safety,
    envs: config.envs,
  };
}

/**
 * Interpolate ${VAR_NAME} placeholders in a string using process.env.
 */
export function interpolateEnvVars(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

function interpolateAuth(auth: AuthConfig | undefined): AuthConfig | undefined {
  if (!auth) return undefined;
  return {
    type: auth.type,
    ...(auth.username !== undefined ? { username: interpolateEnvVars(auth.username) } : {}),
    ...(auth.password !== undefined ? { password: interpolateEnvVars(auth.password) } : {}),
    ...(auth.token !== undefined ? { token: interpolateEnvVars(auth.token) } : {}),
    ...(auth.apiKey !== undefined ? { apiKey: interpolateEnvVars(auth.apiKey) } : {}),
    ...(auth.apiKeyHeader !== undefined ? { apiKeyHeader: interpolateEnvVars(auth.apiKeyHeader) } : {}),
    ...(auth.apiKeyQueryParam !== undefined
      ? { apiKeyQueryParam: interpolateEnvVars(auth.apiKeyQueryParam) }
      : {}),
    ...(auth.cookieName !== undefined ? { cookieName: interpolateEnvVars(auth.cookieName) } : {}),
    ...(auth.cookieValue !== undefined ? { cookieValue: interpolateEnvVars(auth.cookieValue) } : {}),
    ...(auth.scopes !== undefined ? { scopes: auth.scopes.map((scope) => interpolateEnvVars(scope) ?? "") } : {}),
  };
}

function interpolateEnvConfig(entry: EnvConfig): EnvConfig {
  return {
    url: interpolateEnvVars(entry.url) ?? entry.url,
    ...(entry.authType !== undefined ? { authType: entry.authType } : {}),
    ...(entry.username !== undefined ? { username: interpolateEnvVars(entry.username) } : {}),
    ...(entry.password !== undefined ? { password: interpolateEnvVars(entry.password) } : {}),
    ...(entry.token !== undefined ? { token: interpolateEnvVars(entry.token) } : {}),
    ...(entry.apiKey !== undefined ? { apiKey: interpolateEnvVars(entry.apiKey) } : {}),
    ...(entry.apiKeyHeader !== undefined ? { apiKeyHeader: interpolateEnvVars(entry.apiKeyHeader) } : {}),
    ...(entry.apiKeyQueryParam !== undefined
      ? { apiKeyQueryParam: interpolateEnvVars(entry.apiKeyQueryParam) }
      : {}),
    ...(entry.cookieName !== undefined ? { cookieName: interpolateEnvVars(entry.cookieName) } : {}),
    ...(entry.cookieValue !== undefined ? { cookieValue: interpolateEnvVars(entry.cookieValue) } : {}),
    ...(entry.scopes !== undefined
      ? { scopes: entry.scopes.map((scope) => interpolateEnvVars(scope) ?? "") }
      : {}),
    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
    ...(entry.retries !== undefined ? { retries: entry.retries } : {}),
    ...(entry.retryOn !== undefined ? { retryOn: entry.retryOn } : {}),
  };
}

function resolveEnvConfig(
  envs: Record<string, EnvConfig> | undefined,
  envName: string | undefined
): { auth?: AuthConfig; servers?: DefinedServerConfig[]; timeout?: number; retries?: number; retryOn?: number[] } | undefined {
  if (!envs || Object.keys(envs).length === 0) {
    return undefined;
  }

  const name = envName ?? Object.keys(envs)[0];
  const raw = envs[name];
  if (!raw) {
    throw new Error(`Environment "${name}" not found in config. Available: ${Object.keys(envs).join(", ")}`);
  }

  const entry = interpolateEnvConfig(raw);
  const auth = buildAuthFromEnvConfig(entry);

  return {
    auth,
    servers: [{ url: entry.url, ...(auth ? { auth } : {}) }],
    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
    ...(entry.retries !== undefined ? { retries: entry.retries } : {}),
    ...(entry.retryOn !== undefined ? { retryOn: entry.retryOn } : {}),
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

  if (authType === "oauth2" || authType === "openidconnect") {
    return {
      type: authType,
      ...(entry.token ? { token: entry.token } : {}),
      ...(entry.scopes ? { scopes: entry.scopes } : {}),
    };
  }

  if (authType === "cookie") {
    return {
      type: "cookie",
      ...(entry.cookieName ? { cookieName: entry.cookieName } : {}),
      ...(entry.cookieValue ? { cookieValue: entry.cookieValue } : {}),
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
          url: interpolateEnvVars(server.url) ?? server.url,
          ...(server.name ? { name: server.name } : {}),
          ...(server.description ? { description: server.description } : {}),
          ...(server.auth ? { auth: interpolateAuth(server.auth) } : {}),
        }
  );
}
