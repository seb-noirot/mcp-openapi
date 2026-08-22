import { AuthConfig } from "./types";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";

interface ParseAuthConfigOptions {
  defaultToNone?: boolean;
  includeEnvironment?: boolean;
}

interface ParseAuthConfigRequiredOptions extends ParseAuthConfigOptions {
  defaultToNone?: true;
}

interface ParseAuthConfigOptionalOptions extends ParseAuthConfigOptions {
  defaultToNone: false;
}

const SUPPORTED_AUTH_TYPES = ["none", "basic", "bearer", "apikey"] as const;

export function isSupportedAuthType(value: unknown): value is AuthConfig["type"] {
  return typeof value === "string" && SUPPORTED_AUTH_TYPES.includes(value as AuthConfig["type"]);
}

/**
 * Create an axios instance configured for the given auth and base URL.
 */
export function createHttpClient(
  baseURL: string,
  auth: AuthConfig | undefined
): AxiosInstance {
  const config: AxiosRequestConfig = { baseURL };

  const instance = axios.create(config);

  if (!auth || auth.type === "none") {
    return instance;
  }

  instance.interceptors.request.use((reqConfig) => {
    if (auth.type === "basic" && auth.username && auth.password) {
      const credentials = Buffer.from(
        `${auth.username}:${auth.password}`
      ).toString("base64");
      reqConfig.headers = reqConfig.headers ?? {};
      reqConfig.headers["Authorization"] = `Basic ${credentials}`;
    } else if (auth.type === "bearer" && auth.token) {
      reqConfig.headers = reqConfig.headers ?? {};
      reqConfig.headers["Authorization"] = "Bearer " + auth.token;
    } else if (auth.type === "apikey") {
      if (auth.apiKeyHeader && auth.apiKey) {
        reqConfig.headers = reqConfig.headers ?? {};
        reqConfig.headers[auth.apiKeyHeader] = auth.apiKey;
      } else if (auth.apiKeyQueryParam && auth.apiKey) {
        reqConfig.params = {
          ...reqConfig.params,
          [auth.apiKeyQueryParam]: auth.apiKey,
        };
      }
    }
    return reqConfig;
  });

  return instance;
}

/**
 * Parse auth configuration from CLI args or environment variables.
 */
export function parseAuthConfig(
  args: string[],
  options?: ParseAuthConfigRequiredOptions
): AuthConfig;
export function parseAuthConfig(
  args: string[],
  options: ParseAuthConfigOptionalOptions
): AuthConfig | undefined;
export function parseAuthConfig(
  args: string[],
  options: ParseAuthConfigOptions = {}
): AuthConfig | undefined {
  const defaultToNone = options.defaultToNone ?? true;
  const includeEnvironment = options.includeEnvironment ?? true;
  const authType =
    getArg(args, "--auth-type") ??
    (includeEnvironment ? process.env["AUTH_TYPE"] : undefined);

  if (!authType) {
    return defaultToNone ? { type: "none" } : undefined;
  }

  if (authType === "basic") {
    return {
      type: "basic",
      username:
        getArg(args, "--auth-username") ??
        (includeEnvironment ? process.env["AUTH_USERNAME"] : undefined),
      password:
        getArg(args, "--auth-password") ??
        (includeEnvironment ? process.env["AUTH_PASSWORD"] : undefined),
    };
  }

  if (authType === "bearer") {
    return {
      type: "bearer",
      token:
        getArg(args, "--auth-token") ??
        (includeEnvironment ? process.env["AUTH_TOKEN"] : undefined),
    };
  }

  if (authType === "apikey") {
    return {
      type: "apikey",
      apiKey:
        getArg(args, "--api-key") ??
        (includeEnvironment ? process.env["API_KEY"] : undefined),
      apiKeyHeader:
        getArg(args, "--api-key-header") ??
        (includeEnvironment ? process.env["API_KEY_HEADER"] : undefined),
      apiKeyQueryParam:
        getArg(args, "--api-key-query-param") ??
        (includeEnvironment ? process.env["API_KEY_QUERY_PARAM"] : undefined),
    };
  }

  if (authType === "none") {
    return { type: "none" };
  }

  throw new Error(`Unsupported auth type: ${authType}`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}
