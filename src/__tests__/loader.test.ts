import * as fs from "fs";
import * as path from "path";
import { loadOpenApiSpec } from "../loader";

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
});
