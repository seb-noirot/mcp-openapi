#!/usr/bin/env node

import { McpOpenApiServer } from "./server";
import { parseAuthConfig } from "./auth";
import { loadConfigFile } from "./config";
import { ServerConfig } from "./types";

function printUsage(): void {
  console.error(`
Usage: mcp-openapi [options] <openapi-path-or-url>

Options:
  --config <path>           Path to a JSON/YAML config file
  --env <name>              Environment to use from the config file's "envs" map
  --server <url>            Base URL to use (overrides servers from spec). Can be repeated.
  --server-index <n>        Index of server to use from spec/config (default: 0)
  --tool-prefix <prefix>    Prefix to add to built-in and generated tool names
  --auth-type <type>        Authentication type: none | basic | bearer | apikey (default: none)
  --auth-username <user>    Username for basic auth
  --auth-password <pass>    Password for basic auth
  --auth-token <token>      Token for bearer auth
  --api-key <key>           API key value
  --api-key-header <header> Header name for API key (e.g. X-API-Key)
  --api-key-query-param <p> Query parameter name for API key
  --help                    Show this help

Environment variables:
  AUTH_TYPE                 Authentication type
  AUTH_USERNAME             Username for basic auth
  AUTH_PASSWORD             Password for basic auth
  AUTH_TOKEN                Token for bearer auth
  API_KEY                   API key value
  API_KEY_HEADER            Header name for API key
  API_KEY_QUERY_PARAM       Query parameter name for API key

Examples:
  mcp-openapi ./openapi.json
  mcp-openapi https://api.example.com/openapi.yaml --auth-type bearer --auth-token mytoken
  mcp-openapi ./spec.yaml --server https://api.example.com --auth-type basic --auth-username admin --auth-password secret
  mcp-openapi --config ./mcp-openapi.config.yaml
  mcp-openapi --config ./mcp-openapi.config.yaml --env dev
`);
}

function parseArgs(args: string[]): { config: ServerConfig } {
  const servers: string[] = [];
  let serverIndex: number | undefined;
  let openApiPath: string | undefined;
  let configPath: string | undefined;
  let toolPrefix: string | undefined;
  let envName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = consumeArgValue(args, ++i, "--config");
    } else if (args[i] === "--config") {
      throw new Error("Missing value for --config");
    } else if (args[i] === "--env" && i + 1 < args.length) {
      envName = consumeArgValue(args, ++i, "--env");
    } else if (args[i] === "--env") {
      throw new Error("Missing value for --env");
    } else if (args[i] === "--server" && i + 1 < args.length) {
      servers.push(consumeArgValue(args, ++i, "--server"));
    } else if (args[i] === "--server") {
      throw new Error("Missing value for --server");
    } else if (args[i] === "--server-index" && i + 1 < args.length) {
      serverIndex = parseInt(consumeArgValue(args, ++i, "--server-index"), 10);
    } else if (args[i] === "--server-index") {
      throw new Error("Missing value for --server-index");
    } else if (args[i] === "--tool-prefix" && i + 1 < args.length) {
      toolPrefix = consumeArgValue(args, ++i, "--tool-prefix");
    } else if (args[i] === "--tool-prefix") {
      throw new Error("Missing value for --tool-prefix");
    } else if (
      args[i] === "--auth-type" ||
      args[i] === "--auth-username" ||
      args[i] === "--auth-password" ||
      args[i] === "--auth-token" ||
      args[i] === "--api-key" ||
      args[i] === "--api-key-header" ||
      args[i] === "--api-key-query-param"
    ) {
      consumeArgValue(args, i + 1, args[i]);
      i++; // skip value, handled by parseAuthConfig
    } else if (!args[i].startsWith("--")) {
      openApiPath = args[i];
    } else {
      throw new Error(`Unknown option: ${args[i]}`);
    }
  }

  const fileConfig = configPath ? loadConfigFile(configPath, envName) : {};
  const cliAuth = parseAuthConfig(args, {
    defaultToNone: false,
    includeEnvironment: false,
  });
  const envAuth = parseAuthConfig([], {
    defaultToNone: false,
    includeEnvironment: true,
  });
  const auth = cliAuth ?? fileConfig.auth ?? envAuth;

  const config: ServerConfig = {
    openApiPath: openApiPath ?? fileConfig.openApiPath ?? "",
    ...(auth ? { auth } : {}),
    ...(servers.length > 0
      ? { servers: servers.map((url) => ({ url })) }
      : fileConfig.servers
        ? { servers: fileConfig.servers }
        : {}),
    serverIndex: serverIndex ?? fileConfig.serverIndex ?? 0,
    toolPrefix: toolPrefix ?? fileConfig.toolPrefix,
  };

  return { config };
}

function consumeArgValue(args: string[], valueIndex: number, flag: string): string {
  const value = args[valueIndex];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let config: ServerConfig;

  try {
    ({ config } = parseArgs(args));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}\n`);
    printUsage();
    process.exit(1);
  }

  if (!config.openApiPath) {
    console.error("Error: OpenAPI spec path or URL is required.\n");
    printUsage();
    process.exit(1);
  }

  const mcpServer = new McpOpenApiServer(config);

  try {
    await mcpServer.run();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-openapi] Failed to start: ${msg}`);
    process.exit(1);
  }
}

main();
