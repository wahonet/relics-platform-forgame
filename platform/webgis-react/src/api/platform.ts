import { apiClient } from "./client";

export async function fetchPlatformConfig(): Promise<PlatformConfig> {
  if (window.__PLATFORM_CONFIG) {
    return window.__PLATFORM_CONFIG as PlatformConfig;
  }
  const { data } = await apiClient.get<PlatformConfig>("/api/platform/config");
  window.__PLATFORM_CONFIG = data;
  return data;
}

export async function login(username: string, password: string) {
  const { data } = await apiClient.post("/api/login", { username, password });
  return data;
}
