import { AuthConfig } from "./types";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";

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
export function parseAuthConfig(args: string[]): AuthConfig {
  const authType = getArg(args, "--auth-type") ?? process.env["AUTH_TYPE"] ?? "none";

  if (authType === "basic") {
    return {
      type: "basic",
      username: getArg(args, "--auth-username") ?? process.env["AUTH_USERNAME"],
      password: getArg(args, "--auth-password") ?? process.env["AUTH_PASSWORD"],
    };
  }

  if (authType === "bearer") {
    return {
      type: "bearer",
      token: getArg(args, "--auth-token") ?? process.env["AUTH_TOKEN"],
    };
  }

  if (authType === "apikey") {
    return {
      type: "apikey",
      apiKey: getArg(args, "--api-key") ?? process.env["API_KEY"],
      apiKeyHeader:
        getArg(args, "--api-key-header") ??
        process.env["API_KEY_HEADER"],
      apiKeyQueryParam:
        getArg(args, "--api-key-query-param") ??
        process.env["API_KEY_QUERY_PARAM"],
    };
  }

  return { type: "none" };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}
