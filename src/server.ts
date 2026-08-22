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
  schemaToJsonSchema,
} from "./generator";
import { createHttpClient, isSupportedAuthType } from "./auth";
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
  EXPLAIN_OPERATION: "explain_operation",
  EXPLAIN_AUTH: "explain_auth",
  GET_OPERATION_SCHEMA: "get_operation_schema",
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

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.EXPLAIN_OPERATION)) {
      return this.handleExplainOperation(args);
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.EXPLAIN_AUTH)) {
      return this.handleExplainAuth();
    }

    if (toolName === this.getToolName(EXTRA_TOOL_NAMES.GET_OPERATION_SCHEMA)) {
      return this.handleGetOperationSchema(args);
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
    } else if (this.currentAuth.type === "apikey") {
      activeAuth["apiKeySet"] = !!this.currentAuth.apiKey;
      activeAuth["apiKeyHeader"] = this.currentAuth.apiKeyHeader ?? "(not set)";
      activeAuth["apiKeyQueryParam"] =
        this.currentAuth.apiKeyQueryParam ?? "(not set)";
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
          description: "HTTP ****** authentication. Sends token in the Authorization header.",
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

  async run(): Promise<void> {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write(
      `[mcp-openapi] Server started. Spec: ${this.config.openApiPath}, Base URL: ${this.activeBaseUrl}, Tools: ${this.tools.length}\n`
    );
  }
}
