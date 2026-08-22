/**
 * Types for the mcp-openapi server
 */

export interface AuthConfig {
  type: "none" | "basic" | "bearer" | "apikey";
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyQueryParam?: string;
}

export interface EnvConfig {
  url: string;
  authType?: "none" | "basic" | "bearer" | "apikey";
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyQueryParam?: string;
  timeout?: number;
  retries?: number;
  retryOn?: number[];
}

export interface DefinedServerConfig {
  url: string;
  name?: string;
  description?: string;
  auth?: AuthConfig;
}

export interface FilterRule {
  tag?: string;
  method?: string;
  operationId?: string;
}

export interface ServerConfig {
  openApiPath: string;
  servers?: DefinedServerConfig[];
  auth?: AuthConfig;
  serverIndex?: number;
  toolPrefix?: string;
  include?: FilterRule[];
  exclude?: FilterRule[];
  maxResponseBodyBytes?: number;
  timeout?: number;
  retries?: number;
  retryOn?: number[];
  /** Named environments map, preserved so switch_env can look up entries at runtime */
  envs?: Record<string, EnvConfig>;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: OpenApiSchema;
}

export interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  $ref?: string;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  example?: unknown;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiResponse {
  description?: string;
  headers?: Record<string, { description?: string; schema?: OpenApiSchema }>;
  content?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  deprecated?: boolean;
  security?: Record<string, string[]>[];
}

export type OpenApiPathItem = {
  parameters?: OpenApiParameter[];
} & {
  [method: string]: OpenApiOperation | OpenApiParameter[] | undefined;
};

export interface OpenApiPaths {
  [path: string]: OpenApiPathItem;
}

export interface OpenApiComponents {
  schemas?: Record<string, OpenApiSchema>;
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
}

export interface OpenApiSecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
  description?: string;
}

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: OpenApiPaths;
  components?: OpenApiComponents;
  security?: Record<string, string[]>[];
}

export interface McpToolDefinition {
  method: string;
  path: string;
  operationId: string;
  name: string;
  description: string;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  tags?: string[];
}
