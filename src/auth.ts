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

const SUPPORTED_AUTH_TYPES = [
  "none",
  "basic",
  "bearer",
  "apikey",
  "oauth2",
  "openidconnect",
  "cookie",
] as const;

export interface HttpClientOptions {
  timeout?: number;
  retries?: number;
  retryOn?: number[];
  debug?: boolean;
  includeRequestId?: boolean;
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
  const includeRequestId = options?.includeRequestId ?? true;

  instance.interceptors.request.use((reqConfig) => {
    const req = reqConfig as AxiosRequestConfig & {
      __requestMeta?: { requestId: string; startedAt: number; attempt: number };
    };
    req.__requestMeta = req.__requestMeta ?? {
      requestId: randomRequestId(),
      startedAt: Date.now(),
      attempt: 0,
    };
    req.headers = req.headers ?? {};
    if (includeRequestId && req.headers["x-request-id"] === undefined) {
      req.headers["x-request-id"] = req.__requestMeta.requestId;
    }
    if (options?.debug) {
      debugLog(
        `request method=${String(req.method ?? "GET").toUpperCase()} url=${String(req.url ?? "")} requestId=${req.__requestMeta.requestId} attempt=${req.__requestMeta.attempt}`
      );
    }
    return req;
  });

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
    } else if ((auth.type === "oauth2" || auth.type === "openidconnect") && auth.token) {
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
    } else if (auth.type === "cookie" && auth.cookieName && auth.cookieValue) {
      reqConfig.headers = reqConfig.headers ?? {};
      const existing = String(reqConfig.headers["Cookie"] ?? "");
      const cookiePart = `${auth.cookieName}=${auth.cookieValue}`;
      reqConfig.headers["Cookie"] = existing ? `${existing}; ${cookiePart}` : cookiePart;
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
  const shouldRetryResponse = (
    status: number | undefined,
    attempt: number,
    method: string | undefined
  ): boolean => {
    if (attempt >= maxRetries) return false;
    const safeMethod = isRetryableMethod(method);
    if (!safeMethod) return false;
    if (retryOn.length > 0) {
      return status !== undefined && retryOn.includes(status);
    }
    return status === 429 || (status !== undefined && status >= 500);
  };

  instance.interceptors.response.use(
    async (response) => {
      const cfg = response.config as AxiosRequestConfig & {
        __retryAttempt?: number;
        __requestMeta?: { requestId: string; startedAt: number; attempt: number };
      };
      const attempt: number = cfg.__retryAttempt ?? 0;
      if (shouldRetryResponse(response.status, attempt, cfg.method)) {
        cfg.__retryAttempt = attempt + 1;
        cfg.__requestMeta = cfg.__requestMeta ?? {
          requestId: randomRequestId(),
          startedAt: Date.now(),
          attempt: 0,
        };
        cfg.__requestMeta.attempt = cfg.__retryAttempt;
        const delay = computeRetryDelayMs(attempt, response.headers?.["retry-after"]);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return instance.request(cfg);
      }
      return response;
    },
    async (error: unknown) => {
      const axiosError = error as {
        config?: AxiosRequestConfig & { __retryAttempt?: number };
      };
      const config = axiosError?.config;
      if (!config) return Promise.reject(error);

      const attempt: number = config.__retryAttempt ?? 0;
      const shouldRetry =
        attempt < maxRetries &&
        isRetryableMethod(config.method) &&
        (retryOn.length === 0 || retryOn.includes(0));

      if (!shouldRetry) return Promise.reject(error);

      config.__retryAttempt = attempt + 1;
      const delay = computeRetryDelayMs(attempt);
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

  if (authType === "oauth2" || authType === "openidconnect") {
    return {
      type: authType,
      token:
        getArg(args, "--auth-token") ??
        (includeEnvironment ? process.env["AUTH_TOKEN"] : undefined),
      scopes: getArg(args, "--auth-scopes")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  if (authType === "cookie") {
    return {
      type: "cookie",
      cookieName:
        getArg(args, "--cookie-name") ??
        (includeEnvironment ? process.env["AUTH_COOKIE_NAME"] : undefined),
      cookieValue:
        getArg(args, "--cookie-value") ??
        (includeEnvironment ? process.env["AUTH_COOKIE_VALUE"] : undefined),
    };
  }

  if (authType === "none") {
    return { type: "none" };
  }

  function randomRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isRetryableMethod(method: string | undefined): boolean {
    const normalized = String(method ?? "GET").toUpperCase();
    return ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(normalized);
  }

  function computeRetryDelayMs(attempt: number, retryAfterHeader?: string): number {
    if (retryAfterHeader) {
      const secs = Number(retryAfterHeader);
      if (!Number.isNaN(secs) && secs >= 0) {
        return Math.floor(secs * 1000);
      }
      const dateMs = Date.parse(retryAfterHeader);
      if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
      }
    }
    return Math.pow(2, attempt) * 200;
  }

  function debugLog(message: string): void {
    process.stderr.write(`[mcp-openapi][http] ${message}\n`);
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
