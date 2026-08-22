import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { AxiosInstance } from "axios";
import { createHash } from "crypto";
import { loadOpenApiSpec } from "./loader";
import { buildAuthFromEnvConfig } from "./config";
import {
  generateTools,
  buildInputSchema,
  extractRequestBodySchema,
  normalizeToolPrefix,
  schemaToJsonSchema,
} from "./generator";
import { createHttpClient, HttpClientOptions, isSupportedAuthType } from "./auth";
import { executeToolCall } from "./executor";
import {
  AuthConfig,
  DefinedServerConfig,
  McpToolDefinition,
  OpenApiOperation,
  OpenApiSpec,
  ServerConfig,
} from "./types";

const EXTRA_TOOL_NAMES = {
  DISCOVER: "discover_tools",
  INFO: "get_info",
  SETUP: "get_setup",
  SET_AUTH: "set_auth",
  SWITCH_ENV: "switch_env",
  EXPLAIN_OPERATION: "explain_operation",
  EXPLAIN_AUTH: "explain_auth",
  GET_OPERATION_SCHEMA: "get_operation_schema",
  PAGINATE_OPERATION: "paginate_operation",
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
  private activeEnvName?: string;
  private fileWatcher?: fs.FSWatcher;
  private remoteSpecPollTimer?: NodeJS.Timeout;
  private specFingerprint = "";

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
    this.specFingerprint = this.computeSpecFingerprint();

    // Determine base URL
    this.activeBaseUrl = this.resolveBaseUrl();
    this.currentAuth = this.resolveCurrentAuth();

    // Create HTTP client
    this.httpClient = createHttpClient(
      this.activeBaseUrl,
      this.currentAuth,
      this.buildHttpClientOptions()
    );

    // Generate tools from spec
    this.tools = generateTools(
      this.spec,
      this.config.toolPrefix,
      this.config.include,
      this.config.exclude
    );

    this.setupHandlers();
  }

  private buildHttpClientOptions(): HttpClientOptions {
    return {
      timeout: this.config.timeout,
      retries: this.config.retries,
      retryOn: this.config.retryOn,
      debug: this.config.observability?.debug,
      includeRequestId: this.config.observability?.includeRequestId,
    };
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
        const serialized =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        const truncated = this.truncateResponse(serialized);
        return {
          content: [{ type: "text", text: truncated }],
        };
      } catch (error) {
        const msg = this.normalizeErrorPayload(error);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    });
  }

  /**
   * Truncate a serialized response to maxResponseBodyBytes if configured.
   */
  private truncateResponse(text: string): string {
    const limit = this.config.maxResponseBodyBytes;
    if (!limit) return text;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= limit) return text;
    const truncated = truncateUtf8ToBytes(text, limit);
    return `${truncated}\n…[truncated: response exceeded ${limit} bytes]`;
  }

  private getExtraToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const defs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
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
          "Update the authentication configuration at runtime. Supported types: none, basic, bearer, apikey, oauth2, openidconnect, cookie.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["none", "basic", "bearer", "apikey", "oauth2", "openidconnect", "cookie"],
              description: "Authentication type",
            },
            username: { type: "string", description: "Username for basic auth" },
            password: { type: "string", description: "Password for basic auth" },
            token: { type: "string", description: "Token for bearer auth" },
            apiKey: { type: "string", description: "API key value" },
            scopes: {
              type: "array",
              items: { type: "string" },
              description: "Scopes for oauth2/openidconnect token context",
            },
            apiKeyHeader: {
              type: "string",
              description: "Header name for API key (e.g. X-API-Key)",
            },
            apiKeyQueryParam: {
              type: "string",
              description: "Query parameter name for API key",
            },
            cookieName: { type: "string", description: "Cookie name for cookie auth" },
            cookieValue: { type: "string", description: "Cookie value for cookie auth" },
          },
          required: ["type"],
        },
      },
    ];

    // switch_env is only exposed when envs are configured
    if (this.config.envs && Object.keys(this.config.envs).length > 0) {
      defs.push({
        name: this.getToolName(EXTRA_TOOL_NAMES.SWITCH_ENV),
        description:
          "Switch to a named environment defined in the config file. Changes the base URL and authentication without restarting.",
        inputSchema: {
          type: "object",
          properties: {
            env: {
              type: "string",
              description: `Name of the environment to activate. Available: ${Object.keys(this.config.envs).join(", ")}`,
            },
          },
          required: ["env"],
        },
      });
    }

    defs.push(
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.EXPLAIN_OPERATION),
        description:
          "Return a full human-readable breakdown of an API operation: HTTP method, path, summary, parameters, request body, response schemas, authentication requirements, and required headers. Look up by tool name, operationId, or path+method.",
        inputSchema: {
          type: "object",
          properties: {
            toolName: {
              type: "string",
              description: "The MCP tool name of the operation (e.g. list_pets)",
            },
            operationId: {
              type: "string",
              description: "The operationId from the OpenAPI spec",
            },
            path: {
              type: "string",
              description: "The API path (e.g. /pets/{id})",
            },
            method: {
              type: "string",
              description: "The HTTP method (e.g. GET, POST)",
            },
          },
        },
      },
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.EXPLAIN_AUTH),
        description:
          "Return a detailed explanation of the active authentication, all security schemes defined in the OpenAPI spec, global security requirements, and how to configure each supported auth type in this MCP server.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.GET_OPERATION_SCHEMA),
        description:
          "Return the raw JSON schemas for a specific operation's request body and response bodies, useful for programmatic inspection or building integration code. Look up by tool name, operationId, or path+method.",
        inputSchema: {
          type: "object",
          properties: {
            toolName: {
              type: "string",
              description: "The MCP tool name of the operation",
            },
            operationId: {
              type: "string",
              description: "The operationId from the OpenAPI spec",
            },
            path: {
              type: "string",
              description: "The API path",
            },
            method: {
              type: "string",
              description: "The HTTP method",
            },
          },
        },
      },
      {
        name: this.getToolName(EXTRA_TOOL_NAMES.PAGINATE_OPERATION),
        description:
          "Execute a generated list operation across paginated responses and aggregate results. Supports page/offset token-style query pagination.",
        inputSchema: {
          type: "object",
          properties: {
            toolName: { type: "string", description: "Tool name to execute repeatedly" },
            maxPages: {
              type: "integer",
              description: "Maximum number of pages to fetch (default from config or 5)",
            },
            pageParam: { type: "string", description: "Page query parameter name (default: page)" },
            pageStart: { type: "integer", description: "Initial page value (default: 1)" },
            limitParam: { type: "string", description: "Limit/page size query parameter name" },
            limit: { type: "integer", description: "Limit/page size value" },
            nextTokenField: {
              type: "string",
              description: "Field name from response data carrying next cursor/token",
            },
            dataField: {
              type: "string",
              description: "Field name containing list items when using page-based pagination (default: items)",
            },
            tokenParam: {
              type: "string",
              description: "Query parameter name used to pass next token",
            },
            args: {
              type: "object",
              description: "Base arguments passed to each operation call",
            },
          },
          required: ["toolName"],
        },
      }
    );

    return defs;
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

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.SWITCH_ENV)) {
      return this.handleSwitchEnv(args);
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.EXPLAIN_OPERATION)) {
      return this.handleExplainOperation(args);
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.EXPLAIN_AUTH)) {
      return this.handleExplainAuth();
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.GET_OPERATION_SCHEMA)) {
      return this.handleGetOperationSchema(args);
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.PAGINATE_OPERATION)) {
      return this.handlePaginateOperation(args);
    }

    // Dynamic API tools
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    this.assertSafetyRules(tool, args);

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
      activeEnv: this.activeEnvName,
      activeServerIndex: this.selectedServerIndex,
      activeServerSource: this.selectedServerSource,
      authType: this.currentAuth.type,
      // Auth credentials are intentionally masked
      authSummary: this.maskAuth(this.currentAuth),
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

  /** Return a redacted summary of the current auth — never exposes raw secrets. */
  private maskAuth(auth: AuthConfig): Record<string, unknown> {
    const result: Record<string, unknown> = { type: auth.type };
    if (auth.type === "basic") {
      result["username"] = auth.username ?? "(not set)";
      result["password"] = auth.password ? "***" : "(not set)";
    } else if (auth.type === "bearer") {
      result["token"] = auth.token ? "***" : "(not set)";
    } else if (auth.type === "oauth2" || auth.type === "openidconnect") {
      result["token"] = auth.token ? "***" : "(not set)";
      result["scopes"] = auth.scopes ?? [];
    } else if (auth.type === "apikey") {
      result["apiKey"] = auth.apiKey ? "***" : "(not set)";
      result["apiKeyHeader"] = auth.apiKeyHeader ?? "(not set)";
      result["apiKeyQueryParam"] = auth.apiKeyQueryParam ?? "(not set)";
    } else if (auth.type === "cookie") {
      result["cookieName"] = auth.cookieName ?? "(not set)";
      result["cookieValue"] = auth.cookieValue ? "***" : "(not set)";
    }
    return result;
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
      cookieName: args["cookieName"] as string | undefined,
      cookieValue: args["cookieValue"] as string | undefined,
      scopes: Array.isArray(args["scopes"])
        ? (args["scopes"] as string[])
        : undefined,
    };

    this.httpClient = createHttpClient(
      this.activeBaseUrl,
      this.currentAuth,
      this.buildHttpClientOptions()
    );

    return {
      success: true,
      message: `Authentication updated to type: ${authType}`,
      authType: this.currentAuth.type,
    };
  }

  private handleSwitchEnv(args: Record<string, unknown>): unknown {
    const envName = args["env"];
    if (typeof envName !== "string") {
      throw new Error("env must be a string");
    }

    const envs = this.config.envs;
    if (!envs) {
      throw new Error("No environments configured");
    }

    const entry = envs[envName];
    if (!entry) {
      throw new Error(
        `Environment "${envName}" not found. Available: ${Object.keys(envs).join(", ")}`
      );
    }

    // Apply env URL and auth
    this.activeBaseUrl = entry.url;
    this.activeEnvName = envName;
    this.selectedServerSource = "config";
    this.selectedServerIndex = 0;

    // Build auth from the env entry
    const authFromEnv = buildAuthFromEnvConfig(entry);
    this.currentAuth = authFromEnv ?? { type: "none" };

    this.httpClient = createHttpClient(this.activeBaseUrl, this.currentAuth, {
      timeout: entry.timeout ?? this.config.timeout,
      retries: entry.retries ?? this.config.retries,
      retryOn: entry.retryOn ?? this.config.retryOn,
    });

    return {
      success: true,
      message: `Switched to environment: ${envName}`,
      env: envName,
      baseUrl: this.activeBaseUrl,
      authType: this.currentAuth.type,
    };
  }

  /**
   * Find a tool by tool name, operationId, or path+method from args.
   */
  private findToolFromArgs(
    args: Record<string, unknown>
  ): McpToolDefinition | undefined {
    if (args["toolName"] && typeof args["toolName"] === "string") {
      return this.tools.find((t) => t.name === args["toolName"]);
    }
    if (args["operationId"] && typeof args["operationId"] === "string") {
      return this.tools.find((t) => t.operationId === args["operationId"]);
    }
    if (
      args["path"] &&
      typeof args["path"] === "string" &&
      args["method"] &&
      typeof args["method"] === "string"
    ) {
      const method = (args["method"] as string).toUpperCase();
      return this.tools.find(
        (t) => t.path === args["path"] && t.method === method
      );
    }
    return undefined;
  }

  /**
   * Get the raw OpenApiOperation from the spec for a given tool.
   */
  private getRawOperation(tool: McpToolDefinition): OpenApiOperation | undefined {
    const pathItem = this.spec.paths?.[tool.path];
    if (!pathItem) return undefined;
    return pathItem[tool.method.toLowerCase() as keyof typeof pathItem] as
      | OpenApiOperation
      | undefined;
  }

  private handleExplainOperation(args: Record<string, unknown>): unknown {
    const tool = this.findToolFromArgs(args);
    if (!tool) {
      throw new Error(
        "Operation not found. Provide one of: toolName, operationId, or path+method."
      );
    }

    const op = this.getRawOperation(tool);

    // Parameters grouped by location
    const paramsByLocation: Record<string, unknown[]> = {};
    for (const param of tool.parameters) {
      const loc = param.in;
      if (!paramsByLocation[loc]) paramsByLocation[loc] = [];
      paramsByLocation[loc].push({
        name: param.name,
        required: param.required ?? false,
        description: param.description,
        type: param.schema?.type ?? "string",
        format: param.schema?.format,
        enum: param.schema?.enum,
        default: param.schema?.default,
      });
    }

    // Request body
    let requestBodyInfo: unknown = null;
    if (tool.requestBody) {
      const contentTypes = tool.requestBody.content
        ? Object.keys(tool.requestBody.content)
        : [];
      const bodySchema = extractRequestBodySchema(tool.requestBody, this.spec);
      requestBodyInfo = {
        required: tool.requestBody.required ?? false,
        description: tool.requestBody.description,
        contentTypes,
        schema: bodySchema ? schemaToJsonSchema(bodySchema, this.spec) : null,
      };
    }

    // Response schemas
    const responses: Record<string, unknown> = {};
    if (op?.responses) {
      for (const [statusCode, response] of Object.entries(op.responses)) {
        const contentTypes = response.content ? Object.keys(response.content) : [];
        const firstContent = response.content
          ? Object.values(response.content)[0]
          : undefined;
        const schema = firstContent?.schema
          ? schemaToJsonSchema(firstContent.schema, this.spec)
          : null;
        responses[statusCode] = {
          description: response.description,
          contentTypes,
          schema,
        };
      }
    }

    // Authentication requirements
    const effectiveSecurity = op?.security ?? this.spec.security ?? [];
    const securitySchemes = this.spec.components?.securitySchemes ?? {};
    const authRequirements = effectiveSecurity.map((req) =>
      Object.entries(req).map(([schemeName, scopes]) => {
        const scheme = securitySchemes[schemeName];
        return {
          schemeName,
          scopes,
          schemeType: scheme?.type,
          schemeDetails: scheme
            ? {
                scheme: scheme.scheme,
                in: scheme.in,
                name: scheme.name,
                bearerFormat: scheme.bearerFormat,
                description: scheme.description,
              }
            : undefined,
        };
      })
    );

    return {
      toolName: tool.name,
      operationId: tool.operationId,
      method: tool.method,
      path: tool.path,
      summary: op?.summary,
      description: op?.description,
      tags: tool.tags ?? [],
      parameters: paramsByLocation,
      requestBody: requestBodyInfo,
      responses,
      authRequirements,
      deprecated: op?.deprecated ?? false,
    };
  }

  private handleExplainAuth(): unknown {
    const securitySchemes = this.spec.components?.securitySchemes ?? {};
    const globalSecurity = this.spec.security ?? [];

    // Describe active auth
    const activeAuth: Record<string, unknown> = {
      type: this.currentAuth.type,
    };
    if (this.currentAuth.type === "basic") {
      activeAuth["username"] = this.currentAuth.username ?? "(not set)";
      activeAuth["passwordSet"] = !!this.currentAuth.password;
    } else if (this.currentAuth.type === "bearer") {
      activeAuth["tokenSet"] = !!this.currentAuth.token;
    } else if (
      this.currentAuth.type === "oauth2" ||
      this.currentAuth.type === "openidconnect"
    ) {
      activeAuth["tokenSet"] = !!this.currentAuth.token;
      activeAuth["scopes"] = this.currentAuth.scopes ?? [];
    } else if (this.currentAuth.type === "apikey") {
      activeAuth["apiKeySet"] = !!this.currentAuth.apiKey;
      activeAuth["apiKeyHeader"] = this.currentAuth.apiKeyHeader ?? "(not set)";
      activeAuth["apiKeyQueryParam"] =
        this.currentAuth.apiKeyQueryParam ?? "(not set)";
    } else if (this.currentAuth.type === "cookie") {
      activeAuth["cookieName"] = this.currentAuth.cookieName ?? "(not set)";
      activeAuth["cookieValueSet"] = !!this.currentAuth.cookieValue;
    }

    // Security schemes from spec
    const schemesInfo = Object.entries(securitySchemes).map(
      ([name, scheme]) => ({
        name,
        type: scheme.type,
        scheme: scheme.scheme,
        in: scheme.in,
        headerOrParamName: scheme.name,
        bearerFormat: scheme.bearerFormat,
        description: scheme.description,
      })
    );

    // Global security requirements
    const globalRequirements = globalSecurity.map((req) =>
      Object.entries(req).map(([schemeName, scopes]) => ({
        schemeName,
        scopes,
      }))
    );

    return {
      activeAuth,
      specSecuritySchemes: schemesInfo,
      globalSecurityRequirements: globalRequirements,
      configurationGuide: {
        none: {
          description: "No authentication. No additional fields required.",
          fields: {},
        },
        basic: {
          description: "HTTP Basic authentication (username + password).",
          fields: {
            type: "basic",
            username: "Your username",
            password: "Your password",
          },
        },
        bearer: {
          description: "HTTP access-token authentication. Sends token in the Authorization header.",
          fields: {
            type: "bearer",
            token: "Your bearer token",
          },
        },
        apikey: {
          description:
            "API key authentication. Supply the key via a header or query parameter.",
          fields: {
            type: "apikey",
            apiKey: "Your API key value",
            apiKeyHeader: "Header name (e.g. X-API-Key) — use this OR apiKeyQueryParam",
            apiKeyQueryParam:
              "Query parameter name (e.g. api_key) — use this OR apiKeyHeader",
          },
        },
        oauth2: {
          description:
            "OAuth2 access token mode. Provide a valid token from your identity provider.",
          fields: {
            type: "oauth2",
            token: "OAuth2 access token",
            scopes: ["optional", "scope", "list"],
          },
        },
        openidconnect: {
          description:
            "OpenID Connect bearer access token mode. Provide a valid OIDC access token.",
          fields: {
            type: "openidconnect",
            token: "OIDC access token",
            scopes: ["optional", "scope", "list"],
          },
        },
        cookie: {
          description: "Cookie-based auth. Sends Cookie header with configured name/value.",
          fields: {
            type: "cookie",
            cookieName: "Cookie name",
            cookieValue: "Cookie value",
          },
        },
      },
    };
  }

  private handleGetOperationSchema(args: Record<string, unknown>): unknown {
    const tool = this.findToolFromArgs(args);
    if (!tool) {
      throw new Error(
        "Operation not found. Provide one of: toolName, operationId, or path+method."
      );
    }

    const op = this.getRawOperation(tool);

    // Request body schema
    const requestBodySchema = tool.requestBody
      ? extractRequestBodySchema(tool.requestBody, this.spec)
      : undefined;

    const requestBody = requestBodySchema
      ? schemaToJsonSchema(requestBodySchema, this.spec)
      : null;

    // Response schemas keyed by status code and content type
    const responseSchemas: Record<string, unknown> = {};
    if (op?.responses) {
      for (const [statusCode, response] of Object.entries(op.responses)) {
        if (response.content) {
          responseSchemas[statusCode] = {};
          for (const [contentType, mediaType] of Object.entries(
            response.content
          )) {
            (responseSchemas[statusCode] as Record<string, unknown>)[
              contentType
            ] = mediaType.schema
              ? schemaToJsonSchema(mediaType.schema, this.spec)
              : null;
          }
        } else {
          responseSchemas[statusCode] = null;
        }
      }
    }

    // Full input schema (parameters + body)
    const inputSchema = buildInputSchema(
      tool.parameters,
      requestBodySchema,
      this.spec
    );

    return {
      toolName: tool.name,
      operationId: tool.operationId,
      method: tool.method,
      path: tool.path,
      inputSchema,
      requestBodySchema: requestBody,
      responseSchemas,
    };
  }

  private async handlePaginateOperation(args: Record<string, unknown>): Promise<unknown> {
    const toolName = args["toolName"];
    if (typeof toolName !== "string") {
      throw new Error("toolName must be a string");
    }
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const maxPagesArg = Number(args["maxPages"] ?? this.config.paginationMaxPages ?? 5);
    const maxPages = Number.isInteger(maxPagesArg) && maxPagesArg > 0 ? maxPagesArg : 5;
    const pageParam = typeof args["pageParam"] === "string" ? args["pageParam"] : "page";
    const pageStart = Number(args["pageStart"] ?? 1);
    const limitParam = typeof args["limitParam"] === "string" ? args["limitParam"] : undefined;
    const limit = args["limit"];
    const nextTokenField =
      typeof args["nextTokenField"] === "string" ? args["nextTokenField"] : undefined;
    const dataField = typeof args["dataField"] === "string" ? args["dataField"] : "items";
    const tokenParam = typeof args["tokenParam"] === "string" ? args["tokenParam"] : undefined;
    const baseArgs =
      args["args"] && typeof args["args"] === "object" && !Array.isArray(args["args"])
        ? (args["args"] as Record<string, unknown>)
        : {};

    const pages: unknown[] = [];
    let nextToken: unknown = undefined;
    let pageNumber = pageStart;

    for (let i = 0; i < maxPages; i++) {
      const callArgs: Record<string, unknown> = { ...baseArgs };
      if (tokenParam && nextToken !== undefined) {
        callArgs[tokenParam] = nextToken;
      } else if (!tokenParam) {
        callArgs[pageParam] = pageNumber;
      }
      if (limitParam && limit !== undefined) {
        callArgs[limitParam] = limit;
      }

      this.assertSafetyRules(tool, callArgs);
      const pageResult = await executeToolCall(tool, callArgs, this.httpClient, this.spec);
      pages.push(pageResult);

      const data = (
        pageResult as { data?: Record<string, unknown>; ok?: boolean }
      )?.data;
      if ((pageResult as { ok?: boolean }).ok === false) {
        break;
      }

      if (tokenParam && nextTokenField && data && typeof data === "object") {
        nextToken = data[nextTokenField];
        if (nextToken === undefined || nextToken === null || nextToken === "") break;
      } else {
        const hasItems =
          Array.isArray((data as Record<string, unknown> | undefined)?.[dataField]) &&
          ((data as Record<string, unknown>)[dataField] as unknown[]).length > 0;
        if (!hasItems) {
          break;
        }
        pageNumber += 1;
      }
    }

    return {
      toolName,
      pagesFetched: pages.length,
      maxPages,
      pages,
    };
  }

  private assertSafetyRules(tool: McpToolDefinition, args: Record<string, unknown>): void {
    const safety = this.config.safety;
    if (!safety) return;

    const method = tool.method.toUpperCase();
    if (safety.denyMethods?.some((m) => m.toUpperCase() === method)) {
      throw new Error(`Safety policy blocked method ${method}`);
    }
    if (safety.denyOperationIds?.includes(tool.operationId)) {
      throw new Error(`Safety policy blocked operationId ${tool.operationId}`);
    }
    if (safety.denyToolNames?.includes(tool.name)) {
      throw new Error(`Safety policy blocked tool ${tool.name}`);
    }
    if (safety.denyPaths?.includes(tool.path)) {
      throw new Error(`Safety policy blocked path ${tool.path}`);
    }

    const destructiveMethods = (safety.destructiveMethods ?? ["DELETE"]).map((m) =>
      m.toUpperCase()
    );
    if (safety.requireConfirmForDestructive && destructiveMethods.includes(method)) {
      if (args["confirm"] !== true) {
        throw new Error(
          `Tool ${tool.name} (${tool.method} ${tool.path}) requires { "confirm": true } by safety policy`
        );
      }
    }
  }

  private normalizeErrorPayload(error: unknown): string {
    if (error instanceof Error) {
      try {
        const parsed = JSON.parse(error.message) as { error?: unknown };
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          return JSON.stringify(parsed, null, 2);
        }
      } catch {
        // fall through
      }
      return JSON.stringify(
        {
          error: {
            category: "runtime",
            code: "TOOL_EXECUTION_FAILED",
            message: error.message,
          },
        },
        null,
        2
      );
    }
    return JSON.stringify(
      {
        error: {
          category: "runtime",
          code: "TOOL_EXECUTION_FAILED",
          message: String(error),
        },
      },
      null,
      2
    );
  }

  private computeSpecFingerprint(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.spec.paths ?? {}))
      .digest("hex");
  }

  private async reloadSpecAndReportChanges(sourceLabel: string): Promise<void> {
    const previousFingerprint = this.specFingerprint;
    const previousToolNames = new Set(this.tools.map((t) => t.name));
    this.spec = await loadOpenApiSpec(this.config.openApiPath);
    this.tools = generateTools(
      this.spec,
      this.config.toolPrefix,
      this.config.include,
      this.config.exclude
    );
    this.specFingerprint = this.computeSpecFingerprint();
    const nextToolNames = new Set(this.tools.map((t) => t.name));
    const added = [...nextToolNames].filter((n) => !previousToolNames.has(n));
    const removed = [...previousToolNames].filter((n) => !nextToolNames.has(n));
    const changed = previousFingerprint !== this.specFingerprint;
    if (changed) {
      process.stderr.write(
        `[mcp-openapi] Spec drift detected (${sourceLabel}). Tool set changed: +${added.length}/-${removed.length}.\n`
      );
    } else {
      process.stderr.write(`[mcp-openapi] Spec reloaded (${sourceLabel}). No tool changes.\n`);
    }
  }

  async run(watch = false): Promise<void> {
    await this.initialize();

    if (watch) {
      if (!isRemoteSource(this.config.openApiPath)) {
        this.startWatcher();
      } else {
        this.startRemoteSpecPolling();
      }
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write(
      `[mcp-openapi] Server started. Spec: ${this.config.openApiPath}, Base URL: ${this.activeBaseUrl}, Tools: ${this.tools.length}${watch ? " [watch]" : ""}\n`
    );
  }

  private startWatcher(): void {
    const specPath = this.config.openApiPath;
    try {
      this.fileWatcher = fs.watch(specPath, { persistent: false }, async (event) => {
        if (event !== "change") return;
        process.stderr.write(
          `[mcp-openapi] Spec file changed, reloading: ${specPath}\n`
        );
        try {
          await this.reloadSpecAndReportChanges("local watcher");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[mcp-openapi] Failed to reload spec: ${msg}\n`
          );
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[mcp-openapi] Warning: Could not watch spec file: ${msg}\n`
      );
    }
  }

  private startRemoteSpecPolling(): void {
    const intervalMs = this.config.specDriftCheckIntervalMs ?? 60_000;
    this.remoteSpecPollTimer = setInterval(async () => {
      try {
        await this.reloadSpecAndReportChanges("remote poll");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[mcp-openapi] Remote spec poll failed: ${msg}\n`);
      }
    }, intervalMs);
    if (this.remoteSpecPollTimer.unref) {
      this.remoteSpecPollTimer.unref();
    }
  }

  stopWatcher(): void {
    this.fileWatcher?.close();
    this.fileWatcher = undefined;
    if (this.remoteSpecPollTimer) {
      clearInterval(this.remoteSpecPollTimer);
      this.remoteSpecPollTimer = undefined;
    }
  }
}

function truncateUtf8ToBytes(text: string, limit: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= limit) return text;
  let decoded = encoded.subarray(0, limit).toString("utf8");
  if (decoded.includes("\uFFFD")) {
    decoded = decoded.replace(/\uFFFD+$/u, "");
  }
  return decoded;
}

function isRemoteSource(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}
