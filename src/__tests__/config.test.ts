import * as fs from "fs";
import * as path from "path";
import { loadConfigFile } from "../config";

describe("loadConfigFile", () => {
  const tmpDir = path.join(process.cwd(), "tmp-config-test");

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should load YAML config with relative spec path and server auth", () => {
    const configPath = path.join(tmpDir, "mcp-openapi.config.yaml");
    const specPath = path.join(tmpDir, "spec.yaml");
    fs.writeFileSync(specPath, "openapi: 3.0.0\ninfo:\n  title: Test\n  version: '1'\npaths: {}\n");
    fs.writeFileSync(
      configPath,
      [
        "openApiPath: ./spec.yaml",
        "toolPrefix: sample",
        "serverIndex: 1",
        "servers:",
        "  - url: https://api.one.example",
        "    name: primary",
        "  - url: https://api.two.example",
        "    auth:",
        "      type: bearer",
        "      token: config-token",
        "",
      ].join("\n")
    );

    const config = loadConfigFile(configPath);

    expect(config.openApiPath).toBe(specPath);
    expect(config.toolPrefix).toBe("sample");
    expect(config.serverIndex).toBe(1);
    expect(config.servers).toHaveLength(2);
    expect(config.servers?.[1].auth?.type).toBe("bearer");
  });

  it("should load JSON config with string server entries", () => {
    const configPath = path.join(tmpDir, "mcp-openapi.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        openApiPath: "https://example.com/openapi.json",
        servers: ["https://api.example.com"],
      })
    );

    const config = loadConfigFile(configPath);

    expect(config.openApiPath).toBe("https://example.com/openapi.json");
    expect(config.servers).toEqual([{ url: "https://api.example.com" }]);
  });
});
