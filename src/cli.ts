#!/usr/bin/env node

import { McpOpenApiServer } from "./server";
import { parseAuthConfig } from "./auth";
import { ServerConfig } from "./types";

function printUsage(): void {
  console.error(`
Usage: mcp-openapi [options] <openapi-path-or-url>

Options:
  --server <url>            Base URL to use (overrides servers from spec). Can be repeated.
  --server-index <n>        Index of server to use from spec/config (default: 0)
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
`);
}

function parseArgs(args: string[]): { config: ServerConfig; remaining: string[] } {
  const servers: string[] = [];
  const remaining: string[] = [];
  let serverIndex = 0;
  let openApiPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server" && i + 1 < args.length) {
      servers.push(args[++i]);
    } else if (args[i] === "--server-index" && i + 1 < args.length) {
      serverIndex = parseInt(args[++i], 10);
    } else if (
      args[i] === "--auth-type" ||
      args[i] === "--auth-username" ||
      args[i] === "--auth-password" ||
      args[i] === "--auth-token" ||
      args[i] === "--api-key" ||
      args[i] === "--api-key-header" ||
      args[i] === "--api-key-query-param"
    ) {
      i++; // skip value, handled by parseAuthConfig
    } else if (!args[i].startsWith("--")) {
      openApiPath = args[i];
    } else {
      remaining.push(args[i]);
    }
  }

  const auth = parseAuthConfig(args);

  const config: ServerConfig = {
    openApiPath,
    auth,
    ...(servers.length > 0 ? { servers } : {}),
    serverIndex,
  };

  return { config, remaining };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const { config } = parseArgs(args);

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
