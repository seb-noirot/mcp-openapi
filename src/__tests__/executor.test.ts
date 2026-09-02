import { executeToolCall } from "../executor";
import { McpToolDefinition, OpenApiSpec } from "../types";

describe("executeToolCall", () => {
  const spec: OpenApiSpec = {
    openapi: "3.0.0",
    info: { title: "Test", version: "1" },
    paths: {},
  };

  const tool: McpToolDefinition = {
    method: "GET",
    path: "/pets/{id}",
    operationId: "getPet",
    name: "get_pet",
    description: "Get pet",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "integer" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ],
  };

  it("coerces numeric values and returns metadata", async () => {
    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        statusText: "OK",
        data: { id: 1 },
        headers: { "x-request-id": "req-1" },
        config: { __retryAttempt: 2 },
      }),
    };

    const result = (await executeToolCall(
      tool,
      { id: "1", limit: "10" },
      httpClient as never,
      spec
    )) as Record<string, unknown>;

    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/pets/1",
        params: { limit: 10 },
      })
    );
    expect(result["ok"]).toBe(true);
    expect((result["meta"] as Record<string, unknown>)["requestId"]).toBe("req-1");
    expect((result["meta"] as Record<string, unknown>)["retryCount"]).toBe(2);
  });

  it("returns validation error for invalid input", async () => {
    const httpClient = {
      request: jest.fn(),
    };
    await expect(
      executeToolCall(tool, { id: "abc" }, httpClient as never, spec)
    ).rejects.toThrow("INVALID_TOOL_INPUT");
    expect(httpClient.request).not.toHaveBeenCalled();
  });
});
