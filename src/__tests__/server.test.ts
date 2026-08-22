import * as fs from "fs";
import * as path from "path";
import { McpOpenApiServer } from "../server";
import { ServerConfig } from "../types";

describe("McpOpenApiServer", () => {
  const tmpDir = path.join(process.cwd(), "tmp-server-test");

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(filename: string, spec: object): string {
    const specPath = path.join(tmpDir, filename);
    fs.writeFileSync(specPath, JSON.stringify(spec));
    return specPath;
  }

  it("should prefix built-in tools and expose server info", async () => {
    const specPath = writeSpec("spec.json", {
      openapi: "3.0.0",
      info: { title: "Server Test", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const config: ServerConfig = {
      openApiPath: specPath,
      toolPrefix: "petstore",
      serverIndex: 5,
      servers: [
        { url: "https://api.one.example", auth: { type: "basic", username: "u", password: "p" } },
        { url: "https://api.two.example", name: "secondary", auth: { type: "bearer", token: "t" } },
      ],
    };

    const server = new McpOpenApiServer(config);
    await server.initialize();

    const extraTools = (server as any).getExtraToolDefinitions();
    const info = (server as any).handleGetInfo();

    expect(extraTools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        "petstore_discover_tools",
        "petstore_get_info",
        "petstore_get_setup",
        "petstore_set_auth",
        "petstore_explain_operation",
        "petstore_explain_auth",
        "petstore_get_operation_schema",
      ])
    );
    expect(info["authType"]).toBe("bearer");
    expect(info["activeServerIndex"]).toBe(1);
    expect(info["activeBaseUrl"]).toBe("https://api.two.example");
    expect(info["toolPrefix"]).toBe("petstore_");
    expect(info["definedServers"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "secondary",
          authType: "bearer",
          isActive: true,
        }),
      ])
    );
  });

  describe("handleExplainOperation", () => {
    async function makeServer(specOverride?: object): Promise<McpOpenApiServer> {
      const spec = specOverride ?? {
        openapi: "3.0.0",
        info: { title: "Test API", version: "1.0.0" },
        security: [{ ApiKeyAuth: [] }],
        components: {
          schemas: {
            Pet: {
              type: "object",
              required: ["name"],
              properties: {
                id: { type: "integer" },
                name: { type: "string", description: "Pet name" },
              },
            },
          },
          securitySchemes: {
            ApiKeyAuth: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
              description: "API Key authentication",
            },
          },
        },
        paths: {
          "/pets/{id}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              description: "Returns a single pet by ID.",
              tags: ["pets"],
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                  description: "Pet ID",
                },
                {
                  name: "X-Request-Id",
                  in: "header",
                  required: false,
                  schema: { type: "string" },
                  description: "Request tracing ID",
                },
              ],
              responses: {
                "200": {
                  description: "A pet",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
            put: {
              operationId: "updatePet",
              summary: "Update a pet",
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                  description: "Pet ID",
                },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
              security: [{ ApiKeyAuth: ["write"] }],
              responses: {
                "200": { description: "Updated" },
              },
            },
          },
        },
      };

      const specPath = writeSpec(`explain-spec-${Date.now()}.json`, spec);
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();
      return server;
    }

    it("looks up operation by toolName", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ toolName: "get_pet" }) as Record<string, unknown>;
      expect(result["operationId"]).toBe("getPet");
      expect(result["method"]).toBe("GET");
      expect(result["path"]).toBe("/pets/{id}");
      expect(result["summary"]).toBe("Get a pet");
      expect(result["description"]).toBe("Returns a single pet by ID.");
      expect(result["tags"]).toEqual(["pets"]);
    });

    it("looks up operation by operationId", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ operationId: "getPet" }) as Record<string, unknown>;
      expect(result["toolName"]).toBe("get_pet");
    });

    it("looks up operation by path+method", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ path: "/pets/{id}", method: "GET" }) as Record<string, unknown>;
      expect(result["operationId"]).toBe("getPet");
    });

    it("throws when operation not found", async () => {
      const server = await makeServer();
      expect(() =>
        (server as any).handleExplainOperation({ toolName: "nonexistent" })
      ).toThrow("Operation not found");
    });

    it("includes path and header parameters grouped by location", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ toolName: "get_pet" }) as Record<string, unknown>;
      const parameters = result["parameters"] as Record<string, unknown[]>;
      expect(parameters["path"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "id", required: true, type: "integer" }),
        ])
      );
      expect(parameters["header"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "X-Request-Id", required: false }),
        ])
      );
    });

    it("includes request body info", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ toolName: "update_pet" }) as Record<string, unknown>;
      const requestBody = result["requestBody"] as Record<string, unknown>;
      expect(requestBody["required"]).toBe(true);
      expect(requestBody["contentTypes"]).toContain("application/json");
      expect(requestBody["schema"]).toBeTruthy();
    });

    it("includes response schemas per status code", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ toolName: "get_pet" }) as Record<string, unknown>;
      const responses = result["responses"] as Record<string, Record<string, unknown>>;
      expect(responses["200"]["description"]).toBe("A pet");
      expect(responses["200"]["contentTypes"]).toContain("application/json");
      expect(responses["200"]["schema"]).toBeTruthy();
      expect(responses["404"]["description"]).toBe("Not found");
    });

    it("includes global auth requirements resolved against security schemes", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ toolName: "get_pet" }) as Record<string, unknown>;
      const authRequirements = result["authRequirements"] as unknown[];
      expect(authRequirements).toHaveLength(1);
      const req = (authRequirements[0] as unknown[])[0] as Record<string, unknown>;
      expect(req["schemeName"]).toBe("ApiKeyAuth");
      expect((req["schemeDetails"] as Record<string, unknown>)["name"]).toBe("X-API-Key");
    });

    it("includes operation-level security overriding global", async () => {
      const server = await makeServer();
      const result = (server as any).handleExplainOperation({ toolName: "update_pet" }) as Record<string, unknown>;
      const authRequirements = result["authRequirements"] as unknown[];
      const req = (authRequirements[0] as unknown[])[0] as Record<string, unknown>;
      expect(req["scopes"]).toEqual(["write"]);
    });
  });

  describe("handleExplainAuth", () => {
    it("returns active auth type and config guide", async () => {
      const specPath = writeSpec("auth-spec.json", {
        openapi: "3.0.0",
        info: { title: "Auth Test", version: "1.0.0" },
        paths: {},
      });
      const config: ServerConfig = {
        openApiPath: specPath,
        auth: { type: "bearer", token: "mytoken" },
      };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const result = (server as any).handleExplainAuth() as Record<string, unknown>;
      const activeAuth = result["activeAuth"] as Record<string, unknown>;
      expect(activeAuth["type"]).toBe("bearer");
      expect(activeAuth["tokenSet"]).toBe(true);

      const guide = result["configurationGuide"] as Record<string, unknown>;
      expect(guide).toHaveProperty("none");
      expect(guide).toHaveProperty("basic");
      expect(guide).toHaveProperty("bearer");
      expect(guide).toHaveProperty("apikey");
    });

    it("includes spec security schemes", async () => {
      const specPath = writeSpec("auth-scheme-spec.json", {
        openapi: "3.0.0",
        info: { title: "Scheme Test", version: "1.0.0" },
        components: {
          securitySchemes: {
            BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
          },
        },
        security: [{ BearerAuth: [] }],
        paths: {},
      });
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const result = (server as any).handleExplainAuth() as Record<string, unknown>;
      const schemes = result["specSecuritySchemes"] as Array<Record<string, unknown>>;
      expect(schemes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "BearerAuth", type: "http", scheme: "bearer" }),
          expect.objectContaining({ name: "ApiKey", type: "apiKey" }),
        ])
      );
      const globalReqs = result["globalSecurityRequirements"] as unknown[][];
      expect((globalReqs[0][0] as Record<string, unknown>)["schemeName"]).toBe("BearerAuth");
    });

    it("handles no security schemes gracefully", async () => {
      const specPath = writeSpec("no-scheme-spec.json", {
        openapi: "3.0.0",
        info: { title: "No Scheme", version: "1.0.0" },
        paths: {},
      });
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const result = (server as any).handleExplainAuth() as Record<string, unknown>;
      expect(result["specSecuritySchemes"]).toEqual([]);
      expect(result["globalSecurityRequirements"]).toEqual([]);
    });
  });

  describe("handleGetOperationSchema", () => {
    async function makeSchemaServer(): Promise<McpOpenApiServer> {
      const specPath = writeSpec(`schema-spec-${Date.now()}.json`, {
        openapi: "3.0.0",
        info: { title: "Schema Test", version: "1.0.0" },
        components: {
          schemas: {
            Pet: {
              type: "object",
              required: ["name"],
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
              },
            },
          },
        },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
              responses: {
                "201": {
                  description: "Created",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
                "400": { description: "Bad request" },
              },
            },
          },
        },
      });
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();
      return server;
    }

    it("returns inputSchema, requestBodySchema, and responseSchemas", async () => {
      const server = await makeSchemaServer();
      const result = (server as any).handleGetOperationSchema({ toolName: "create_pet" }) as Record<string, unknown>;
      expect(result["operationId"]).toBe("createPet");
      expect(result["method"]).toBe("POST");
      expect(result["inputSchema"]).toBeTruthy();
      expect(result["requestBodySchema"]).toBeTruthy();
      const responseSchemas = result["responseSchemas"] as Record<string, unknown>;
      expect(responseSchemas["201"]).toBeTruthy();
      expect(responseSchemas["400"]).toBeNull();
    });

    it("resolves $ref in request body schema", async () => {
      const server = await makeSchemaServer();
      const result = (server as any).handleGetOperationSchema({ toolName: "create_pet" }) as Record<string, unknown>;
      const requestBodySchema = result["requestBodySchema"] as Record<string, unknown>;
      expect(requestBodySchema["type"]).toBe("object");
      expect(requestBodySchema["properties"]).toHaveProperty("name");
    });

    it("throws when operation not found", async () => {
      const server = await makeSchemaServer();
      expect(() =>
        (server as any).handleGetOperationSchema({ toolName: "nonexistent" })
      ).toThrow("Operation not found");
    });

    it("returns null requestBodySchema for GET operations", async () => {
      const specPath = writeSpec(`get-spec-${Date.now()}.json`, {
        openapi: "3.0.0",
        info: { title: "GET Test", version: "1.0.0" },
        paths: {
          "/items": {
            get: {
              operationId: "listItems",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const result = (server as any).handleGetOperationSchema({ toolName: "list_items" }) as Record<string, unknown>;
      expect(result["requestBodySchema"]).toBeNull();
    });
  });

  describe("truncateResponse", () => {
    it("should return the full text when no limit is set", async () => {
      const specPath = writeSpec("spec-trunc-nolimit.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const longText = "a".repeat(10_000);
      const result = (server as any).truncateResponse(longText);
      expect(result).toBe(longText);
    });

    it("should truncate text that exceeds the byte limit", async () => {
      const specPath = writeSpec("spec-trunc-limit.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = { openApiPath: specPath, maxResponseBodyBytes: 10 };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const text = "a".repeat(100);
      const result = (server as any).truncateResponse(text) as string;
      expect(result).toContain("[truncated");
      expect(Buffer.byteLength(result.split("\n")[0]!, "utf8")).toBeLessThanOrEqual(10);
    });
  });

  describe("maskAuth", () => {
    async function makeBasicServer(): Promise<McpOpenApiServer> {
      const specPath = writeSpec("spec-mask.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = {
        openApiPath: specPath,
        auth: { type: "basic", username: "admin", password: "hunter2" },
      };
      const server = new McpOpenApiServer(config);
      await server.initialize();
      return server;
    }

    it("should mask password in basic auth", async () => {
      const server = await makeBasicServer();
      const masked = (server as any).maskAuth(server["currentAuth"]) as Record<string, unknown>;
      expect(masked["username"]).toBe("admin");
      expect(masked["password"]).toBe("***");
    });

    it("should mask bearer token", async () => {
      const specPath = writeSpec("spec-mask-bearer.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = {
        openApiPath: specPath,
        auth: { type: "bearer", token: "supersecret" },
      };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const masked = (server as any).maskAuth(server["currentAuth"]) as Record<string, unknown>;
      expect(masked["token"]).toBe("***");
    });

    it("should include masked auth in getInfoSnapshot", async () => {
      const server = await makeBasicServer();
      const snapshot = (server as any).getInfoSnapshot() as Record<string, unknown>;
      expect(snapshot["authSummary"]).toBeDefined();
      const summary = snapshot["authSummary"] as Record<string, unknown>;
      expect(summary["password"]).toBe("***");
    });
  });

  describe("switch_env tool", () => {
    it("should expose switch_env tool when envs are configured", async () => {
      const specPath = writeSpec("spec-switch-env.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = {
        openApiPath: specPath,
        envs: {
          dev: { url: "https://dev.api.example.com", authType: "none" },
          prod: { url: "https://api.example.com", authType: "none" },
        },
      };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const extraTools = (server as any).getExtraToolDefinitions() as Array<{ name: string }>;
      const toolNames = extraTools.map((t) => t.name);
      expect(toolNames).toContain("switch_env");
    });

    it("should NOT expose switch_env tool when no envs are configured", async () => {
      const specPath = writeSpec("spec-no-switch-env.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = { openApiPath: specPath };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      const extraTools = (server as any).getExtraToolDefinitions() as Array<{ name: string }>;
      const toolNames = extraTools.map((t) => t.name);
      expect(toolNames).not.toContain("switch_env");
    });

    it("should switch active base URL when handleSwitchEnv is called", async () => {
      const specPath = writeSpec("spec-handle-switch.json", {
        openapi: "3.0.0",
        info: { title: "T", version: "1" },
        paths: {},
      });
      const config: ServerConfig = {
        openApiPath: specPath,
        envs: {
          dev: { url: "https://dev.api.example.com", authType: "none" },
          prod: { url: "https://api.example.com", authType: "none" },
        },
      };
      const server = new McpOpenApiServer(config);
      await server.initialize();

      (server as any).handleSwitchEnv({ env: "prod" });
      const snapshot = (server as any).getInfoSnapshot() as Record<string, unknown>;
      expect(snapshot["activeBaseUrl"]).toBe("https://api.example.com");
      expect(snapshot["activeEnv"]).toBe("prod");
    });
  });
});
