import * as fs from "fs";
import * as path from "path";
import { loadOpenApiSpec, resolveServerVariables } from "../loader";

describe("loadOpenApiSpec", () => {
  const tmpDir = path.join(process.cwd(), "tmp-test");

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should load a JSON spec from file", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {},
    };
    const filePath = path.join(tmpDir, "spec.json");
    fs.writeFileSync(filePath, JSON.stringify(spec));

    const loaded = await loadOpenApiSpec(filePath);
    expect(loaded.info.title).toBe("Test");
    expect(loaded.openapi).toBe("3.0.0");
  });

  it("should load a YAML spec from file", async () => {
    const yamlContent = `
openapi: "3.0.0"
info:
  title: YAML Test
  version: "2.0.0"
paths: {}
`;
    const filePath = path.join(tmpDir, "spec.yaml");
    fs.writeFileSync(filePath, yamlContent);

    const loaded = await loadOpenApiSpec(filePath);
    expect(loaded.info.title).toBe("YAML Test");
    expect(loaded.info.version).toBe("2.0.0");
  });

  it("should throw on truly unparseable content", async () => {
    const filePath = path.join(tmpDir, "invalid.txt");
    fs.writeFileSync(filePath, "not a valid spec at all: ::::");

    await expect(loadOpenApiSpec(filePath)).rejects.toThrow();
  });

  it("should throw for missing file", async () => {
    await expect(loadOpenApiSpec("/nonexistent/path/spec.json")).rejects.toThrow();
  });

  it("should normalize a Swagger 2.0 spec to OpenAPI 3 format", async () => {
    const swagger2: object = {
      swagger: "2.0",
      info: { title: "Swagger2 Test", version: "1.0.0" },
      host: "api.example.com",
      basePath: "/v1",
      schemes: ["https"],
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            parameters: [],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };

    const filePath = path.join(tmpDir, "swagger2.json");
    fs.writeFileSync(filePath, JSON.stringify(swagger2));

    const loaded = await loadOpenApiSpec(filePath);

    expect(loaded.servers).toBeDefined();
    expect(loaded.servers![0].url).toBe("https://api.example.com/v1");
    const getOp = loaded.paths?.["/pets"]?.get as import("../types").OpenApiOperation | undefined;
    expect(getOp?.operationId).toBe("listPets");
  });
});

describe("resolveServerVariables", () => {
  it("should replace variable placeholders with default values", () => {
    const server = {
      url: "https://{environment}.api.example.com/{version}",
      variables: {
        environment: { default: "prod", enum: ["dev", "staging", "prod"] },
        version: { default: "v1" },
      },
    };

    const resolved = resolveServerVariables(server);
    expect(resolved.url).toBe("https://prod.api.example.com/v1");
  });

  it("should return the URL unchanged when no variables present", () => {
    const server = { url: "https://api.example.com" };
    const resolved = resolveServerVariables(server);
    expect(resolved.url).toBe("https://api.example.com");
  });

  it("should replace variable with empty string when variable has no default", () => {
    const server = {
      url: "https://{host}/api",
      variables: { host: {} },
    };
    const resolved = resolveServerVariables(server);
    // Variable with no default resolves to the variable name
    expect(resolved.url).toBe("https://host/api");
  });
});
