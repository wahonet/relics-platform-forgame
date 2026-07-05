import { apiClient } from "./client";

export interface PipelineArtifact {
  label: string;
  path: string;
  kind: string;
  exists: boolean;
  count: number;
}

export interface PipelineStep {
  id: string;
  name: string;
  script: string;
  optional: boolean;
  missing_features: string[];
  inputs: PipelineArtifact[];
  outputs: PipelineArtifact[];
  missing_inputs: PipelineArtifact[];
  missing_outputs: PipelineArtifact[];
}

export interface PipelineManifestStep {
  id: string;
  name: string;
  status: string;
  duration_sec?: number;
  error?: string | null;
}

export interface PipelineStatus {
  features: Record<string, boolean>;
  steps: PipelineStep[];
  last_manifest: {
    status: string;
    generated_at: string;
    steps: PipelineManifestStep[];
  } | null;
}

export interface AdminTask {
  status: "idle" | "running" | "done" | "error";
  id?: number;
  label?: string;
  started?: number;
  finished?: number | null;
  returncode?: number | null;
  log?: string[];
}

export interface ApiKeyEntry {
  configured: boolean;
  masked: string;
}

export interface ApiConfigStatus {
  siliconflow: ApiKeyEntry & { base_url: string; default_model: string };
  amap: ApiKeyEntry;
  cesium_ion: ApiKeyEntry;
  config_path: string;
  runtime: { ai_ready: boolean; amap_ready: boolean };
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  const { data } = await apiClient.get<PipelineStatus>("/api/admin/pipeline");
  return data;
}

export async function runPipeline(opts: { only?: string; demo?: boolean }) {
  const { data } = await apiClient.post("/api/admin/pipeline/run", opts);
  return data as { id: number; label: string; status: string };
}

export async function fetchTask(): Promise<AdminTask> {
  const { data } = await apiClient.get<AdminTask>("/api/admin/pipeline/task");
  return data;
}

export async function fetchApiConfig(): Promise<ApiConfigStatus> {
  const { data } = await apiClient.get<ApiConfigStatus>("/api/admin/config");
  return data;
}

export async function saveApiConfig(body: {
  siliconflow_key?: string;
  amap_web_key?: string;
  cesium_ion_token?: string;
}) {
  const { data } = await apiClient.put("/api/admin/config", body);
  return data as {
    ok: boolean;
    changed: boolean;
    message: string;
    runtime?: { ai_ready: boolean; amap_ready: boolean };
  };
}
