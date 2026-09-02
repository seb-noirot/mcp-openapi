#!/usr/bin/env node

import { McpOpenApiServer } from "./server";
import { generateTools } from "./generator";
import { loadOpenApiSpec } from "./loader";
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
  --auth-type <type>        Authentication type: none | basic | bearer | apikey | oauth2 | openidconnect | cookie (default: none)
  --auth-username <user>    Username for basic auth
  --auth-password <pass>    Password for basic auth
  --auth-token <token>      Token for bearer auth
  --api-key <key>           API key value
  --api-key-header <header> Header name for API key (e.g. X-API-Key)
  --api-key-query-param <p> Query parameter name for API key
  --auth-scopes <list>      Comma-separated scopes for oauth2/openidconnect
  --cookie-name <name>      Cookie name for cookie auth
  --cookie-value <value>    Cookie value for cookie auth
  --timeout <ms>            HTTP request timeout in milliseconds
  --retries <n>             Number of retries for failed requests
  --retry-on <codes>        Comma-separated HTTP status codes to retry on (e.g. 429,503)
  --max-response-bytes <n>  Maximum response body size in bytes before truncation
  --dry-run                 Print generated tool names and exit without starting the server
  --watch                   Watch local spec file for changes and reload tools automatically
  --help                    Show this help

Environment variables:
  AUTH_TYPE                 Authentication type
  AUTH_USERNAME             Username for basic auth
  AUTH_PASSWORD             Password for basic auth
  AUTH_TOKEN                Token for bearer auth
  API_KEY                   API key value
  API_KEY_HEADER            Header name for API key
  API_KEY_QUERY_PARAM       Query parameter name for API key
  AUTH_COOKIE_NAME          Cookie name for cookie auth
  AUTH_COOKIE_VALUE         Cookie value for cookie auth

Examples:
  mcp-openapi ./openapi.json
  mcp-openapi https://api.example.com/openapi.yaml --auth-type bearer --auth-token mytoken
  mcp-openapi ./spec.yaml --server https://api.example.com --auth-type basic --auth-username admin --auth-password secret
  mcp-openapi --config ./mcp-openapi.config.yaml
  mcp-openapi --config ./mcp-openapi.config.yaml --env dev
  mcp-openapi ./spec.yaml --dry-run
  mcp-openapi ./spec.yaml --watch
`);
}

function parseArgs(args: string[]): { config: ServerConfig; dryRun: boolean; watch: boolean } {
  const servers: string[] = [];
  let serverIndex: number | undefined;
  let openApiPath: string | undefined;
  let configPath: string | undefined;
  let toolPrefix: string | undefined;
  let envName: string | undefined;
  let timeout: number | undefined;
  let retries: number | undefined;
  let retryOn: number[] | undefined;
  let maxResponseBodyBytes: number | undefined;
  let dryRun = false;
  let watch = false;

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
    } else if (args[i] === "--timeout" && i + 1 < args.length) {
      timeout = parseInt(consumeArgValue(args, ++i, "--timeout"), 10);
    } else if (args[i] === "--timeout") {
      throw new Error("Missing value for --timeout");
    } else if (args[i] === "--retries" && i + 1 < args.length) {
      retries = parseInt(consumeArgValue(args, ++i, "--retries"), 10);
    } else if (args[i] === "--retries") {
      throw new Error("Missing value for --retries");
    } else if (args[i] === "--retry-on" && i + 1 < args.length) {
      retryOn = consumeArgValue(args, ++i, "--retry-on")
        .split(",")
        .map((s) => parseInt(s.trim(), 10));
    } else if (args[i] === "--retry-on") {
      throw new Error("Missing value for --retry-on");
    } else if (args[i] === "--max-response-bytes" && i + 1 < args.length) {
      maxResponseBodyBytes = parseInt(consumeArgValue(args, ++i, "--max-response-bytes"), 10);
    } else if (args[i] === "--max-response-bytes") {
      throw new Error("Missing value for --max-response-bytes");
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--watch") {
      watch = true;
    } else if (
      args[i] === "--auth-type" ||
      args[i] === "--auth-username" ||
      args[i] === "--auth-password" ||
      args[i] === "--auth-token" ||
      args[i] === "--api-key" ||
      args[i] === "--api-key-header" ||
      args[i] === "--api-key-query-param" ||
      args[i] === "--auth-scopes" ||
      args[i] === "--cookie-name" ||
      args[i] === "--cookie-value"
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

  if (envName && !configPath) {
    throw new Error("--env requires --config to be specified");
  }
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
    ...(fileConfig.include ? { include: fileConfig.include } : {}),
    ...(fileConfig.exclude ? { exclude: fileConfig.exclude } : {}),
    ...(maxResponseBodyBytes !== undefined
      ? { maxResponseBodyBytes }
      : fileConfig.maxResponseBodyBytes !== undefined
        ? { maxResponseBodyBytes: fileConfig.maxResponseBodyBytes }
        : {}),
    timeout: timeout ?? fileConfig.timeout,
    retries: retries ?? fileConfig.retries,
    retryOn: retryOn ?? fileConfig.retryOn,
    ...(fileConfig.envs ? { envs: fileConfig.envs } : {}),
  };

  return { config, dryRun, watch };
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
  let dryRun: boolean;
  let watch: boolean;

  try {
    ({ config, dryRun, watch } = parseArgs(args));
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

  if (dryRun) {
    try {
      const spec = await loadOpenApiSpec(config.openApiPath);
      const tools = generateTools(spec, config.toolPrefix, config.include, config.exclude);
      console.log(`Tools generated from ${config.openApiPath} (${tools.length} total):\n`);
      for (const tool of tools) {
        console.log(`  ${tool.name}  [${tool.method} ${tool.path}]`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    return;
  }

  const mcpServer = new McpOpenApiServer(config);

  try {
    await mcpServer.run(watch);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-openapi] Failed to start: ${msg}`);
    process.exit(1);
  }
}

main();
