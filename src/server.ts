import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AxiosInstance } from "axios";
import { loadOpenApiSpec } from "./loader";
import {
  generateTools,
  buildInputSchema,
  extractRequestBodySchema,
  normalizeToolPrefix,
} from "./generator";
import { createHttpClient, isSupportedAuthType } from "./auth";
import { executeToolCall } from "./executor";
import {
  AuthConfig,
  DefinedServerConfig,
  McpToolDefinition,
  OpenApiSpec,
  ServerConfig,
} from "./types";

const EXTRA_TOOL_NAMES = {
  DISCOVER: "discover_tools",
  INFO: "get_info",
  SETUP: "get_setup",
  SET_AUTH: "set_auth",
} as const;

export class McpOpenApiServer {
  private spec!: OpenApiSpec;
  private tools: McpToolDefinition[] = [];
  private httpClient!: AxiosInstance;
  private server: Server;
  private config: ServerConfig;
  private currentAuth: AuthConfig;
  private activeBaseUrl!: string;
  private selectedServerIndex = 0;
  private selectedServerSource: "config" | "spec" | "default" = "default";
  private toolPrefix: string;

  constructor(config: ServerConfig) {
    this.config = config;
    this.currentAuth = config.auth ?? { type: "none" };
    this.toolPrefix = normalizeToolPrefix(config.toolPrefix);
    this.server = new Server(
      { name: "mcp-openapi", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
  }

  async initialize(): Promise<void> {
    this.spec = await loadOpenApiSpec(this.config.openApiPath);

    // Determine base URL
    this.activeBaseUrl = this.resolveBaseUrl();
    this.currentAuth = this.resolveCurrentAuth();

    // Create HTTP client
    this.httpClient = createHttpClient(this.activeBaseUrl, this.currentAuth);

    // Generate tools from spec
    this.tools = generateTools(this.spec, this.config.toolPrefix);

    this.setupHandlers();
  }

  private resolveBaseUrl(): string {
    // 1. Explicit servers from config
    if (this.config.servers && this.config.servers.length > 0) {
      const idx = this.config.serverIndex ?? 0;
      this.selectedServerIndex = this.clampServerIndex(idx, this.config.servers.length);
      this.selectedServerSource = "config";
      return this.config.servers[this.selectedServerIndex]?.url ?? this.config.servers[0].url;
    }

    // 2. Servers from spec
    if (this.spec.servers && this.spec.servers.length > 0) {
      const idx = this.config.serverIndex ?? 0;
      this.selectedServerIndex = this.clampServerIndex(idx, this.spec.servers.length);
      this.selectedServerSource = "spec";
      return this.spec.servers[this.selectedServerIndex]?.url ?? this.spec.servers[0].url;
    }

    this.selectedServerIndex = 0;
    this.selectedServerSource = "default";
    return "http://localhost";
  }

  private resolveCurrentAuth(): AuthConfig {
    if (this.config.auth) {
      return this.config.auth;
    }

    if (this.selectedServerSource === "config" && this.config.servers) {
      return this.config.servers[this.selectedServerIndex]?.auth ?? { type: "none" };
    }

    return { type: "none" };
  }

  private clampServerIndex(index: number, length: number): number {
    if (length <= 0) {
      return 0;
    }

    if (index < 0) {
      return 0;
    }

    return Math.min(index, length - 1);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          ...this.getExtraToolDefinitions(),
          ...this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: buildInputSchema(
              t.parameters,
              extractRequestBodySchema(t.requestBody, this.spec),
              this.spec
            ),
          })),
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      try {
        const result = await this.handleToolCall(toolName, args);
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    });
  }

  private getExtraToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.DISCOVER),
        description:
          "List all available API tools generated from the OpenAPI specification, including their names, descriptions, HTTP method, path, and parameters.",
        inputSchema: {
          type: "object",
          properties: {
            tag: {
              type: "string",
              description: "Optional tag to filter tools by",
            },
            method: {
              type: "string",
              description: "Optional HTTP method to filter by (GET, POST, etc.)",
            },
          },
        },
      },
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.INFO),
        description:
          "Return the current OpenAPI, tool, and server configuration, including the list of defined servers and the active authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.SETUP),
        description:
          "Return the current server setup: OpenAPI spec source, active base URL, authentication type, and number of tools.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.SET_AUTH),
        description:
          "Update the authentication configuration at runtime. Supported types: none, basic, bearer, apikey.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["none", "basic", "bearer", "apikey"],
              description: "Authentication type",
            },
            username: { type: "string", description: "Username for basic auth" },
            password: { type: "string", description: "Password for basic auth" },
            token: { type: "string", description: "Token for bearer auth" },
            apiKey: { type: "string", description: "API key value" },
            apiKeyHeader: {
              type: "string",
              description: "Header name for API key (e.g. X-API-Key)",
            },
            apiKeyQueryParam: {
              type: "string",
              description: "Query parameter name for API key",
            },
          },
          required: ["type"],
        },
      },
    ];
  }

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    // Extra tools
    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.DISCOVER)) {
      return this.handleDiscoverTools(args);
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.INFO)) {
      return this.handleGetInfo();
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.SETUP)) {
      return this.handleGetSetup();
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.SET_AUTH)) {
      return this.handleSetAuth(args);
    }

    // Dynamic API tools
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return executeToolCall(tool, args, this.httpClient, this.spec);
  }

  private getToolName(name: string): string {
    return `${this.toolPrefix}${name}`;
  }

  private handleDiscoverTools(args: Record<string, unknown>): unknown {
    let filteredTools = this.tools;

    if (args["tag"] && typeof args["tag"] === "string") {
      const tag = args["tag"].toLowerCase();
      filteredTools = filteredTools.filter((t) =>
        t.tags?.some((tg) => tg.toLowerCase() === tag)
      );
    }

    if (args["method"] && typeof args["method"] === "string") {
      const method = args["method"].toUpperCase();
      filteredTools = filteredTools.filter((t) => t.method === method);
    }

    return {
      total: filteredTools.length,
      tools: filteredTools.map((t) => ({
        name: t.name,
        description: t.description,
        method: t.method,
        path: t.path,
        operationId: t.operationId,
        tags: t.tags ?? [],
        parameters: t.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required ?? false,
          description: p.description,
        })),
        hasRequestBody: !!t.requestBody,
      })),
    };
  }

  private getDefinedServers(): Array<Record<string, unknown>> {
    if (this.config.servers && this.config.servers.length > 0) {
      return this.config.servers.map((server, index) =>
        this.serializeServer(server, index, "config")
      );
    }

    if (this.spec.servers && this.spec.servers.length > 0) {
      return this.spec.servers.map((server, index) =>
        this.serializeServer(server, index, "spec")
      );
    }

    return [
      {
        index: 0,
        source: "default",
        url: "http://localhost",
        isActive: true,
      },
    ];
  }

  private serializeServer(
    server: DefinedServerConfig | { url: string; description?: string },
    index: number,
    source: "config" | "spec"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      index,
      source,
      url: server.url,
      isActive: this.selectedServerSource === source && this.selectedServerIndex === index,
    };

    if ("name" in server && server.name) {
      result["name"] = server.name;
    }
    if (server.description) {
      result["description"] = server.description;
    }
    if ("auth" in server && server.auth) {
      result["authType"] = server.auth.type;
    }

    return result;
  }

  private getInfoSnapshot(): Record<string, unknown> {
    return {
      openApiSource: this.config.openApiPath,
      toolPrefix: this.toolPrefix,
      activeBaseUrl: this.activeBaseUrl,
      activeServerIndex: this.selectedServerIndex,
      activeServerSource: this.selectedServerSource,
      authType: this.currentAuth.type,
      totalTools: this.tools.length,
      extraTools: Object.values(EXTRA_TOOL_NAMES).map((name) => this.getToolName(name)),
      specInfo: {
        title: this.spec.info?.title,
        version: this.spec.info?.version,
        description: this.spec.info?.description,
      },
      definedServers: this.getDefinedServers(),
    };
  }

  private handleGetInfo(): Record<string, unknown> {
    return this.getInfoSnapshot();
  }

  private handleGetSetup(): Record<string, unknown> {
    const snapshot = this.getInfoSnapshot();
    const {
      openApiSource,
      activeBaseUrl,
      authType,
      totalTools,
      specInfo,
    } = snapshot;
    const definedServers = this.getDefinedServers();

    return {
      openApiSource,
      activeBaseUrl,
      authType,
      totalTools,
      specInfo,
      availableServers: definedServers.map((server) => server["url"]),
    };
  }

  private handleSetAuth(args: Record<string, unknown>): unknown {
    const authType = args["type"];
    if (!isSupportedAuthType(authType)) {
      throw new Error(`Unsupported auth type: ${String(authType)}`);
    }

    this.currentAuth = {
      type: authType,
      username: args["username"] as string | undefined,
      password: args["password"] as string | undefined,
      token: args["token"] as string | undefined,
      apiKey: args["apiKey"] as string | undefined,
      apiKeyHeader: args["apiKeyHeader"] as string | undefined,
      apiKeyQueryParam: args["apiKeyQueryParam"] as string | undefined,
    };

    this.httpClient = createHttpClient(this.activeBaseUrl, this.currentAuth);

    return {
      success: true,
      message: `Authentication updated to type: ${authType}`,
      authType: this.currentAuth.type,
    };
  }

  async run(): Promise<void> {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write(
      `[mcp-openapi] Server started. Spec: ${this.config.openApiPath}, Base URL: ${this.activeBaseUrl}, Tools: ${this.tools.length}\n`
    );
  }
}
