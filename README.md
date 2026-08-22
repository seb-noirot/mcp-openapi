# mcp-openapi

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that **dynamically generates tools** from any OpenAPI definition (JSON or YAML, local file or remote URL).

Point it at any OpenAPI spec and it will expose every operation as an MCP tool — ready for AI assistants like Claude, Cursor, and others.

---

## Features

- **Dynamic tool generation** — tools are created from your OpenAPI spec at startup, using `summary`, `description`, `tags`, and `parameters` from the spec.
- **Flexible spec loading** — accepts a local file path (JSON or YAML) or a remote URL.
- **Multiple server support** — override the base URL(s) via CLI flags or use the servers defined in the spec.
- **Authentication** — supports `none`, `basic`, `bearer`, and `apikey` auth.
- **Runtime auth updates** — change auth without restarting via the `set_auth` tool.
- **Discovery tool** — list all available tools with filtering by tag or HTTP method.
- **Setup tool** — inspect the current configuration at any time.

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
  --server <url>              Base URL to use (overrides servers from spec). Can be repeated.
  --server-index <n>          Index of server to use from spec/config (default: 0)
  --auth-type <type>          Authentication type: none | basic | bearer | apikey (default: none)
  --auth-username <user>      Username for basic auth
  --auth-password <pass>      Password for basic auth
  --auth-token <token>        Token for bearer auth
  --api-key <key>             API key value
  --api-key-header <header>   Header name for API key (e.g. X-API-Key)
  --api-key-query-param <p>   Query parameter name for API key
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

| Tool             | Description                                                                                   |
|------------------|-----------------------------------------------------------------------------------------------|
| `discover_tools` | List all generated API tools. Optionally filter by `tag` or `method`.                        |
| `get_setup`      | Return the current server setup: spec source, base URL, auth type, spec info, and tool count. |
| `set_auth`       | Update authentication configuration at runtime without restarting the server.                 |

---

## How It Works

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
