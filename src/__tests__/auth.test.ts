import { parseAuthConfig } from "../auth";

describe("parseAuthConfig", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env["AUTH_TYPE"];
    delete process.env["AUTH_USERNAME"];
    delete process.env["AUTH_PASSWORD"];
    delete process.env["AUTH_TOKEN"];
    delete process.env["API_KEY"];
    delete process.env["API_KEY_HEADER"];
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("should default to none", () => {
    const auth = parseAuthConfig([]);
    expect(auth.type).toBe("none");
  });

  it("should parse basic auth from args", () => {
    const auth = parseAuthConfig(["--auth-type", "basic", "--auth-username", "user", "--auth-password", "pass"]);
    expect(auth.type).toBe("basic");
    expect(auth.username).toBe("user");
    expect(auth.password).toBe("pass");
  });

  it("should parse bearer auth from args", () => {
    const auth = parseAuthConfig(["--auth-type", "bearer", "--auth-token", "mytoken"]);
    expect(auth.type).toBe("bearer");
    expect(auth.token).toBe("mytoken");
  });

  it("should parse apikey auth from args", () => {
    const auth = parseAuthConfig(["--auth-type", "apikey", "--api-key", "key123", "--api-key-header", "X-API-Key"]);
    expect(auth.type).toBe("apikey");
    expect(auth.apiKey).toBe("key123");
    expect(auth.apiKeyHeader).toBe("X-API-Key");
  });

  it("should fall back to environment variables", () => {
    process.env["AUTH_TYPE"] = "bearer";
    process.env["AUTH_TOKEN"] = "envtoken";
    const auth = parseAuthConfig([]);
    expect(auth.type).toBe("bearer");
    expect(auth.token).toBe("envtoken");
  });

  it("should prefer args over environment variables", () => {
    process.env["AUTH_TYPE"] = "bearer";
    process.env["AUTH_TOKEN"] = "envtoken";
    const auth = parseAuthConfig(["--auth-type", "basic", "--auth-username", "user", "--auth-password", "pass"]);
    expect(auth.type).toBe("basic");
    expect(auth.username).toBe("user");
  });
});
