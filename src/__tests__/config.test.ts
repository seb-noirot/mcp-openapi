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

  describe("envs support", () => {
    it("should resolve the named env specified in the config file", () => {
      const configPath = path.join(tmpDir, "envs-default.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          env: "staging",
          envs: {
            dev: { url: "https://dev.api.example.com", auth_type: "bearer", token: "dev-token" },
            staging: { url: "https://staging.api.example.com", auth_type: "bearer", token: "staging-token" },
          },
        })
      );

      const config = loadConfigFile(configPath);

      expect(config.servers).toHaveLength(1);
      expect(config.servers?.[0].url).toBe("https://staging.api.example.com");
      expect(config.auth?.type).toBe("bearer");
      expect(config.auth?.token).toBe("staging-token");
    });

    it("should prefer the envOverride argument over the env key in the file", () => {
      const configPath = path.join(tmpDir, "envs-override.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          env: "dev",
          envs: {
            dev: { url: "https://dev.api.example.com", auth_type: "bearer", token: "dev-token" },
            prod: { url: "https://api.example.com", auth_type: "bearer", token: "prod-token" },
          },
        })
      );

      const config = loadConfigFile(configPath, "prod");

      expect(config.servers?.[0].url).toBe("https://api.example.com");
      expect(config.auth?.token).toBe("prod-token");
    });

    it("should default to the first env when no env key is present", () => {
      const configPath = path.join(tmpDir, "envs-first.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          envs: {
            dev: { url: "https://dev.api.example.com", auth_type: "none" },
            prod: { url: "https://api.example.com" },
          },
        })
      );

      const config = loadConfigFile(configPath);

      expect(config.servers?.[0].url).toBe("https://dev.api.example.com");
      expect(config.auth?.type).toBe("none");
    });

    it("should handle basic auth in envs", () => {
      const configPath = path.join(tmpDir, "envs-basic.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          envs: {
            dev: {
              url: "https://dev.api.example.com",
              auth_type: "basic",
              username: "admin",
              password: "secret",
            },
          },
        })
      );

      const config = loadConfigFile(configPath);

      expect(config.auth?.type).toBe("basic");
      expect(config.auth?.username).toBe("admin");
      expect(config.auth?.password).toBe("secret");
    });

    it("should handle apikey auth in envs", () => {
      const configPath = path.join(tmpDir, "envs-apikey.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          envs: {
            dev: {
              url: "https://dev.api.example.com",
              auth_type: "apikey",
              apiKey: "mykey",
              apiKeyHeader: "X-API-Key",
            },
          },
        })
      );

      const config = loadConfigFile(configPath);

      expect(config.auth?.type).toBe("apikey");
      expect(config.auth?.apiKey).toBe("mykey");
      expect(config.auth?.apiKeyHeader).toBe("X-API-Key");
    });

    it("should throw when the specified env does not exist", () => {
      const configPath = path.join(tmpDir, "envs-missing.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          envs: {
            dev: { url: "https://dev.api.example.com" },
          },
        })
      );

      expect(() => loadConfigFile(configPath, "notexist")).toThrow(/notexist/);
    });

    it("should not apply envs when envs key is absent", () => {
      const configPath = path.join(tmpDir, "no-envs.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          openApiPath: "https://example.com/openapi.json",
          servers: [{ url: "https://api.example.com" }],
          auth: { type: "bearer", token: "existing-token" },
        })
      );

      const config = loadConfigFile(configPath);

      expect(config.servers?.[0].url).toBe("https://api.example.com");
      expect(config.auth?.token).toBe("existing-token");
    });
  });
});
