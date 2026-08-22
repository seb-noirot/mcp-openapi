# mcp-openapi

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that **dynamically generates tools** from any OpenAPI definition (JSON or YAML, local file or remote URL).

Point it at any OpenAPI spec and it will expose every operation as an MCP tool — ready for AI assistants like Claude, Cursor, and others.

---

## Features

- **Dynamic tool generation** — tools are created from your OpenAPI spec at startup, using `summary`, `description`, `tags`, and `parameters` from the spec.
- **Flexible spec loading** — accepts a local file path (JSON or YAML) or a remote URL.
- **OpenAPI 2.x (Swagger) support** — Swagger 2.0 specs are automatically normalised to OpenAPI 3 format.
- **Multiple server support** — override the base URL(s) via CLI flags or use the servers defined in the spec.
- **Server URL variable templates** — `{variable}` placeholders in server URLs are resolved using `default` values from the spec.
- **Config file support** — load OpenAPI source, tool prefix, servers, and auth from a JSON/YAML config file.
- **Multi-environment config** — define named environments in a config file and switch between them with `--env` or the `switch_env` MCP tool.
- **Env var interpolation** — use `${VAR}` placeholders in any string config value; they are expanded from the process environment at load time.
- **Authentication** — supports `none`, `basic`, `bearer`, and `apikey` auth.
- **Extended auth support** — adds `oauth2`, `openidconnect`, and `cookie` auth modes.
- **Masked auth** — tokens and passwords are redacted to `***` in `get_info` / `get_setup` output.
- **Runtime auth updates** — change auth without restarting via the `set_auth` tool.
- **Strict validation/coercion** — request inputs are validated and coerced against OpenAPI schemas before execution.
- **Structured errors** — consistent error payloads for validation/runtime/HTTP failures.
- **Safety guardrails** — optional confirmation and deny-rules for destructive operations.
- **Pagination helper tool** — run paginated operations and aggregate page results.
- **Operation filtering** — include or exclude operations by tag, HTTP method, or `operationId` using `include`/`exclude` rules in the config file.
- **Response truncation** — cap large API responses to a configurable byte limit.
- **Retry & timeout** — method-aware retries with `Retry-After` handling and exponential back-off.
- **Spec drift detection** — in watch mode, remote specs are polled and tool-set changes are reported.
- **Observability** — request IDs, latency, and retry count in tool execution metadata.
- **Full `$ref` resolution** — circular reference guard prevents infinite loops in complex specs.
- **Tool prefixing** — apply a prefix to built-in and generated tools.
- **Discovery tool** — list all available tools with filtering by tag or HTTP method.
- **Info/setup tools** — inspect the current configuration, active server, and defined servers at any time.
- **Dry-run mode** — validate spec loading and tool generation without starting the MCP server.
- **Watch mode** — automatically reload the spec and regenerate tools when the local file changes.

---

## Quick Start

```bash
npx mcp-openapi ./openapi.yaml
npx mcp-openapi https://petstore3.swagger.io/api/v3/openapi.json
```

---

## Installation

```bash
npm install -g mcp-openapi
# or use directly with npx (no install needed)
npx mcp-openapi <options> <openapi-path-or-url>
```

---

## Usage

```
mcp-openapi [options] <openapi-path-or-url>

Options:
  --config <path>             Path to a JSON/YAML config file
  --env <name>                Environment to use from the config file's "envs" map
  --server <url>              Base URL to use (overrides servers from spec). Can be repeated.
  --server-index <n>          Index of server to use from spec/config (default: 0)
  --tool-prefix <prefix>      Prefix to add to built-in and generated tool names
  --auth-type <type>          Authentication type: none | basic | bearer | apikey | oauth2 | openidconnect | cookie (default: none)
  --auth-username <user>      Username for basic auth
  --auth-password <pass>      Password for basic auth
  --auth-token <token>        Token for bearer auth
  --api-key <key>             API key value
  --api-key-header <header>   Header name for API key (e.g. X-API-Key)
  --api-key-query-param <p>   Query parameter name for API key
  --auth-scopes <list>        Comma-separated scopes for oauth2/openidconnect
  --cookie-name <name>        Cookie name for cookie auth
  --cookie-value <value>      Cookie value for cookie auth
  --timeout <ms>              HTTP request timeout in milliseconds
  --retries <n>               Number of retry attempts on failure (default: 0)
  --retry-on <codes>          Comma-separated HTTP status codes to retry on (e.g. 429,503)
  --max-response-bytes <n>    Truncate response bodies larger than this byte limit
  --dry-run                   Load spec and list tools, then exit without starting the server
  --watch                     Watch the local spec file and reload on change
  --help                      Show this help
```

### Environment Variables

| Variable              | Description                              |
|-----------------------|------------------------------------------|
| `AUTH_TYPE`           | Authentication type                      |
| `AUTH_USERNAME`       | Username for basic auth                  |
| `AUTH_PASSWORD`       | Password for basic auth                  |
| `AUTH_TOKEN`          | Token for bearer auth                    |
| `API_KEY`             | API key value                            |
| `API_KEY_HEADER`      | Header name for API key                  |
| `API_KEY_QUERY_PARAM` | Query parameter name for API key         |
| `AUTH_COOKIE_NAME`    | Cookie name for cookie auth              |
| `AUTH_COOKIE_VALUE`   | Cookie value for cookie auth             |

---

## Examples

### Local file, no auth

```bash
npx mcp-openapi ./openapi.json
```

### Remote URL with bearer auth

```bash
npx mcp-openapi https://api.example.com/openapi.yaml \
  --auth-type bearer \
  --auth-token mytoken
```

### Local file with basic auth and custom server

```bash
npx mcp-openapi ./spec.yaml \
  --server https://api.example.com \
  --auth-type basic \
  --auth-username admin \
  --auth-password secret
```

### Config file with named servers and prefixed tools

```yaml
openApiPath: ./openapi.yaml
toolPrefix: petstore
serverIndex: 1
servers:
  - url: https://sandbox.api.example.com
    name: sandbox
    auth:
      type: bearer
      token: SANDBOX_TOKEN
  - url: https://api.example.com
    name: production
    auth:
      type: bearer
      token: PROD_TOKEN
```

```bash
npx mcp-openapi --config ./mcp-openapi.config.yaml
```

### Multi-environment config file

Use the `envs` key to define named environments, each with its own URL and authentication. The active environment is selected by the `env` key in the file or the `--env` CLI flag (which takes precedence).

```json
{
  "openApiPath": "./openapi.yaml",
  "env": "dev",
  "envs": {
    "dev": {
      "url": "https://dev.api.example.com",
      "authType": "bearer",
      "token": "DEV_TOKEN"
    },
    "staging": {
      "url": "https://staging.api.example.com",
      "authType": "bearer",
      "token": "STAGING_TOKEN"
    },
    "prod": {
      "url": "https://api.example.com",
      "authType": "bearer",
      "token": "PROD_TOKEN"
    }
  }
}
```

```bash
# Use the default env ("dev") defined in the file
npx mcp-openapi --config ./mcp-openapi.config.json

# Override to use the "prod" environment
npx mcp-openapi --config ./mcp-openapi.config.json --env prod
```

Each environment entry supports all auth types:

| Field             | Description                                         |
|-------------------|-----------------------------------------------------|
| `url`             | Base URL for this environment (required)            |
| `authType`       | `none` \| `basic` \| `bearer` \| `apikey` \| `oauth2` \| `openidconnect` \| `cookie` |
| `token`           | Access token (for `bearer`, `oauth2`, `openidconnect`) |
| `username`        | Username (for `basic`)                              |
| `password`        | Password (for `basic`)                              |
| `apiKey`          | API key value (for `apikey`)                        |
| `apiKeyHeader`    | Header name for API key (for `apikey`)              |
| `apiKeyQueryParam`| Query param name for API key (for `apikey`)         |

If no `env` key is present in the file and no `--env` flag is given, the **first** environment in the `envs` map is used.

### API key in a header

```bash
npx mcp-openapi ./openapi.json \
  --auth-type apikey \
  --api-key mykey123 \
  --api-key-header X-API-Key
```

---

## MCP Client Configuration

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": [
        "mcp-openapi",
        "https://api.example.com/openapi.json",
        "--auth-type", "bearer",
        "--auth-token", "YOUR_TOKEN"
      ]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["mcp-openapi", "./openapi.yaml"],
      "env": {
        "AUTH_TYPE": "basic",
        "AUTH_USERNAME": "admin",
        "AUTH_PASSWORD": "secret"
      }
    }
  }
}
```

---

## Built-in Extra Tools

| Tool                    | Description                                                                                                           |
|-------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `discover_tools`        | List all generated API tools. Optionally filter by `tag` or `method`.                                                |
| `get_info`              | Return the current OpenAPI, tool prefix, active server/auth (masked), active env, and the list of defined servers.   |
| `get_setup`             | Return the current server setup: spec source, base URL, auth type, spec info, and tool count.                        |
| `set_auth`              | Update authentication configuration at runtime without restarting the server.                                         |
| `switch_env`            | Switch the active environment at runtime (only present when `envs` is configured). Updates the base URL and auth.    |
| `explain_operation`     | Return a full breakdown of an operation: method, path, parameters, request body, response schemas, and auth requirements. Look up by tool name, operationId, or path+method. |
| `explain_auth`          | Return the active auth config, all security schemes in the spec, global security requirements, and a configuration guide for all supported auth types. |
| `get_operation_schema`  | Return the raw JSON schemas for a specific operation's request body and all response bodies. Useful for building integration code. |
| `paginate_operation`    | Execute a generated tool through multiple pages and aggregate responses. Supports page- and token-based pagination. |

When `--tool-prefix` or `toolPrefix` is set, the same prefix is applied to built-in tools and generated API tools (for example `petstore_get_info` or `petstore_list_pets`).

---

## Advanced Configuration

### Environment Variable Interpolation

Any string value in a config file can reference environment variables using `${VAR}` syntax. Placeholders are expanded at load time using the process environment.

```json
{
  "openApiPath": "${OPENAPI_SPEC_PATH}",
  "envs": {
    "prod": {
      "url": "${API_BASE_URL}",
      "authType": "bearer",
      "token": "${API_TOKEN}"
    }
  }
}
```

Undefined variables expand to an empty string.

---

### Operation Filtering

Use `include` and `exclude` rules in the config file to control which operations become tools. Each rule can match by `tag`, `method`, and/or `operationId` (all specified fields must match — rules within a list are OR-ed).

```json
{
  "openApiPath": "./openapi.yaml",
  "include": [
    { "tag": "pets" },
    { "operationId": "listUsers" }
  ],
  "exclude": [
    { "method": "delete" }
  ]
}
```

`include` is applied first (keep only matching operations), then `exclude` removes matching ones.

---

### Retry and Timeout

```bash
npx mcp-openapi ./openapi.yaml \
  --timeout 5000 \
  --retries 3 \
  --retry-on 429,503
```

Or in a config file:

```json
{
  "openApiPath": "./openapi.yaml",
  "timeout": 5000,
  "retries": 3,
  "retryOn": [429, 503]
}
```

If `retryOn` is omitted, retries apply to HTTP `429` and `5xx` responses for safe methods (`GET`, `HEAD`, `OPTIONS`). Network errors are retried for those same safe methods. Back-off starts at 200 ms and doubles with each attempt.

---

### Response Truncation

Cap large API responses to avoid overwhelming the AI context window:

```bash
npx mcp-openapi ./openapi.yaml --max-response-bytes 102400
```

Or in a config file:

```json
{
  "openApiPath": "./openapi.yaml",
  "maxResponseBodyBytes": 102400
}
```

Truncated responses include a `…[truncated: response exceeded N bytes]` suffix.

---

### Dry-Run Mode

Validate spec loading and tool generation without starting the MCP server:

```bash
npx mcp-openapi ./openapi.yaml --dry-run
```

Prints all generated tool names and exits.

---

### Watch Mode

Automatically reload the spec and regenerate tools when a local spec file changes:

```bash
npx mcp-openapi ./openapi.yaml --watch
```

Watch mode is only available for local files (not remote URLs).

---

### Swagger 2.0 Support

Swagger 2.0 (OpenAPI 2.x) specs are automatically normalised to OpenAPI 3 format at load time. `host`, `basePath`, and `schemes` are combined into a `servers` entry; `body` parameters are converted to `requestBody`; `definitions` become `components.schemas`.

```bash
npx mcp-openapi ./swagger2.json
```

---


1. The server loads the OpenAPI spec from the given path or URL.
2. It iterates over all paths and HTTP methods, skipping deprecated operations.
3. Each operation becomes an MCP tool with:
   - **Name**: derived from `operationId` (converted to `snake_case`) or `method_path`.
   - **Description**: from `summary` and `description` fields.
   - **Input schema**: built from `parameters` (path, query, header) and `requestBody`.
4. When a tool is called, the server makes the corresponding HTTP request using the configured base URL and authentication.

---

## Building from Source

```bash
git clone https://github.com/seb-noirot/mcp-openapi
cd mcp-openapi
npm install
npm run build
node dist/cli.js ./openapi.json
```

## Running Tests

```bash
npm test
```
