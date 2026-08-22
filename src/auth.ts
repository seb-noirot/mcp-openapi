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

export interface HttpClientOptions {
  timeout?: number;
  retries?: number;
  retryOn?: number[];
}

export function isSupportedAuthType(value: unknown): value is AuthConfig["type"] {
  return typeof value === "string" && SUPPORTED_AUTH_TYPES.includes(value as AuthConfig["type"]);
}

/**
 * Create an axios instance configured for the given auth and base URL.
 */
export function createHttpClient(
  baseURL: string,
  auth: AuthConfig | undefined,
  options?: HttpClientOptions
): AxiosInstance {
  const config: AxiosRequestConfig = {
    baseURL,
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
  };

  const instance = axios.create(config);

  if (!auth || auth.type === "none") {
    if (options?.retries) {
      applyRetryInterceptor(instance, options.retries, options.retryOn ?? []);
    }
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

  if (options?.retries) {
    applyRetryInterceptor(instance, options.retries, options.retryOn ?? []);
  }

  return instance;
}

function applyRetryInterceptor(
  instance: AxiosInstance,
  maxRetries: number,
  retryOn: number[]
): void {
  const shouldRetryResponse = (status: number | undefined, attempt: number): boolean => {
    if (attempt >= maxRetries) return false;
    // If retryOn is non-empty, only retry on those specific status codes
    return retryOn.length > 0 && status !== undefined && retryOn.includes(status);
  };

  instance.interceptors.response.use(
    async (response) => {
      // Handle success responses that should be retried (e.g. 429 when retryOn is set)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = response.config as any;
      const attempt: number = cfg.__retryAttempt ?? 0;
      if (shouldRetryResponse(response.status, attempt)) {
        cfg.__retryAttempt = attempt + 1;
        const delay = Math.pow(2, attempt) * 200;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return instance.request(cfg);
      }
      return response;
    },
    async (error: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const axiosError = error as any;
      const config = axiosError?.config;
      if (!config) return Promise.reject(error);

      const attempt: number = config.__retryAttempt ?? 0;
      // For network/timeout errors, retry when retryOn is empty (retry on any error)
      const shouldRetry = attempt < maxRetries && retryOn.length === 0;

      if (!shouldRetry) return Promise.reject(error);

      config.__retryAttempt = attempt + 1;
      const delay = Math.pow(2, attempt) * 200; // exponential back-off: 200ms, 400ms, 800ms…
      await new Promise((resolve) => setTimeout(resolve, delay));
      return instance.request(config);
    }
  );
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
