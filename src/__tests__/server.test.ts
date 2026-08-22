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

  it("should prefix built-in tools and expose server info", async () => {
    const specPath = path.join(tmpDir, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify({
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
      })
    );

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
});
