import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { AuthConfig, DefinedServerConfig, ServerConfig } from "./types";

interface RawServerConfigFile {
  openApiPath?: string;
  serverIndex?: number;
  toolPrefix?: string;
  auth?: AuthConfig;
  servers?: Array<string | DefinedServerConfig>;
}

export function loadConfigFile(configPath: string): Partial<ServerConfig> {
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
  const rawContent = fs.readFileSync(absolutePath, "utf-8");
  const config = parseConfigContent(rawContent, absolutePath);
  const configDir = path.dirname(absolutePath);

  return {
    openApiPath: resolveConfigOpenApiPath(config.openApiPath, configDir),
    serverIndex: config.serverIndex,
    toolPrefix: config.toolPrefix,
    auth: config.auth,
    servers: normalizeDefinedServers(config.servers),
  };
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
