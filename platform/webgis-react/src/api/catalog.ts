import { apiClient } from "./client";
import type { CatalogDataset, CatalogApplication } from "../types";

export async function fetchCatalog(): Promise<CatalogDataset[]> {
  const { data } = await apiClient.get<{ datasets: CatalogDataset[] }>("/api/catalog");
  return data.datasets || [];
}

export async function applyDataset(body: {
  dataset_id: string;
  applicant: string;
  org: string;
  purpose: string;
  contact?: string;
}): Promise<{ ok: boolean; id: number }> {
  const { data } = await apiClient.post("/api/catalog/apply", body);
  return data;
}

export async function listApplications(): Promise<CatalogApplication[]> {
  const { data } = await apiClient.get<{ data: CatalogApplication[] }>(
    "/api/catalog/applications",
  );
  return data.data || [];
}

export async function reviewApplication(
  id: number,
  status: "approved" | "rejected",
  reply = "",
): Promise<CatalogApplication> {
  const { data } = await apiClient.patch(`/api/catalog/applications/${id}`, {
    status,
    reply,
  });
  return data;
}
