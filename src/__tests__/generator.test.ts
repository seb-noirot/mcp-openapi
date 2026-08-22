import {
  generateToolName,
  buildToolDescription,
  generateTools,
  buildInputSchema,
  normalizeToolPrefix,
} from "../generator";
import { OpenApiSpec } from "../types";

describe("generateToolName", () => {
  it("should convert operationId to snake_case", () => {
    expect(generateToolName("get", "/pets", "listPets")).toBe("list_pets");
    expect(generateToolName("post", "/pets", "createPet")).toBe("create_pet");
    expect(generateToolName("get", "/pets/{id}", "getPetById")).toBe("get_pet_by_id");
  });

  it("should handle operationIds with underscores and hyphens", () => {
    expect(generateToolName("get", "/", "get_users")).toBe("get_users");
    expect(generateToolName("get", "/", "get-users")).toBe("get_users");
  });

  it("should fall back to method + path when no operationId", () => {
    const name = generateToolName("get", "/pets");
    expect(name).toMatch(/^get_pets$/);
  });

  it("should handle path parameters in fallback", () => {
    const name = generateToolName("get", "/pets/{petId}");
    expect(name).toContain("get");
    expect(name).toContain("pet");
  });
});

describe("normalizeToolPrefix", () => {
  it("should normalize and suffix the prefix", () => {
    expect(normalizeToolPrefix("PetStore")).toBe("pet_store_");
    expect(normalizeToolPrefix("pet-store")).toBe("pet_store_");
    expect(normalizeToolPrefix("ABC")).toBe("abc_");
  });

  it("should return an empty string when prefix is missing", () => {
    expect(normalizeToolPrefix(undefined)).toBe("");
    expect(normalizeToolPrefix("")).toBe("");
  });
});

describe("buildToolDescription", () => {
  it("should use summary as primary description", () => {
    const desc = buildToolDescription("get", "/pets", "List pets");
    expect(desc).toContain("List pets");
  });

  it("should append description when different from summary", () => {
    const desc = buildToolDescription("get", "/pets", "List pets", "Returns a list of all pets");
    expect(desc).toContain("List pets");
    expect(desc).toContain("Returns a list of all pets");
  });

  it("should include tags", () => {
    const desc = buildToolDescription("get", "/pets", "List pets", undefined, ["pets", "animals"]);
    expect(desc).toContain("Tags: pets, animals");
  });

  it("should fall back to method + path when no summary or description", () => {
    const desc = buildToolDescription("get", "/pets");
    expect(desc).toContain("GET /pets");
  });
});

describe("generateTools", () => {
  const petStoreSpec: OpenApiSpec = {
    openapi: "3.0.0",
    info: { title: "Petstore", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List all pets",
          tags: ["pets"],
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Max pets to return",
              required: false,
              schema: { type: "integer" },
            },
          ],
          responses: { "200": { description: "A list of pets" } },
        },
        post: {
          operationId: "createPet",
          summary: "Create a pet",
          tags: ["pets"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    species: { type: "string" },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: { "201": { description: "Pet created" } },
        },
      },
      "/pets/{petId}": {
        get: {
          operationId: "showPetById",
          summary: "Get a pet by ID",
          tags: ["pets"],
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { "200": { description: "A pet" } },
        },
        delete: {
          operationId: "deletePet",
          deprecated: true,
          summary: "Delete a pet (deprecated)",
          parameters: [],
          responses: { "204": { description: "Deleted" } },
        },
      },
    },
  };

  it("should generate tools for non-deprecated operations", () => {
    const tools = generateTools(petStoreSpec);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_pets");
    expect(names).toContain("create_pet");
    expect(names).toContain("show_pet_by_id");
    // Deprecated operations should be excluded
    expect(names).not.toContain("delete_pet");
  });

  it("should set correct method and path", () => {
    const tools = generateTools(petStoreSpec);
    const listPets = tools.find((t) => t.name === "list_pets");
    expect(listPets?.method).toBe("GET");
    expect(listPets?.path).toBe("/pets");
  });

  it("should include parameters", () => {
    const tools = generateTools(petStoreSpec);
    const listPets = tools.find((t) => t.name === "list_pets");
    expect(listPets?.parameters).toHaveLength(1);
    expect(listPets?.parameters[0].name).toBe("limit");
  });

  it("should include request body", () => {
    const tools = generateTools(petStoreSpec);
    const createPet = tools.find((t) => t.name === "create_pet");
    expect(createPet?.requestBody).toBeDefined();
  });

  it("should deduplicate tool names", () => {
    const specWithDuplicates: OpenApiSpec = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/a": {
          get: {
            operationId: "myOp",
            summary: "First op",
            responses: {},
          },
        },
        "/b": {
          get: {
            operationId: "myOp",
            summary: "Second op with same id",
            responses: {},
          },
        },
      },
    };
    const tools = generateTools(specWithDuplicates);
    const names = tools.map((t) => t.name);
    // Names should be unique
    expect(new Set(names).size).toBe(names.length);
  });

  it("should prefix generated tool names", () => {
    const tools = generateTools(petStoreSpec, "petstore");
    expect(tools.map((t) => t.name)).toContain("petstore_list_pets");
    expect(tools.map((t) => t.name)).toContain("petstore_create_pet");
  });
});

describe("buildInputSchema", () => {
  const emptySpec: OpenApiSpec = {
    openapi: "3.0.0",
    info: { title: "T", version: "1" },
    paths: {},
  };

  it("should include query and path parameters", () => {
    const params = [
      { name: "limit", in: "query" as const, schema: { type: "integer" as const } },
      { name: "id", in: "path" as const, required: true, schema: { type: "string" as const } },
    ];
    const schema = buildInputSchema(params, undefined, emptySpec);
    const props = schema["properties"] as Record<string, unknown>;
    expect(props["limit"]).toBeDefined();
    expect(props["id"]).toBeDefined();
    expect(schema["required"]).toContain("id");
  });

  it("should include request body as 'body' property", () => {
    const bodySchema = {
      type: "object" as const,
      properties: { name: { type: "string" as const } },
    };
    const schema = buildInputSchema([], bodySchema, emptySpec);
    const props = schema["properties"] as Record<string, unknown>;
    expect(props["body"]).toBeDefined();
  });
});
