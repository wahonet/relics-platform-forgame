import { apiClient } from "./client";
import type { WorklogItem } from "../types";

interface WorklogDates {
  items: WorklogItem[];
}

export async function fetchWorklogDates(): Promise<WorklogDates> {
  const { data } = await apiClient.get<WorklogDates>("/api/worklog/dates");
  return data;
}

export async function fetchSurveyRoutes(): Promise<unknown> {
  const { data } = await apiClient.get("/api/survey-routes");
  return data;
}

export async function fetchVillageCoverage(): Promise<unknown> {
  const { data } = await apiClient.get("/api/village-coverage");
  return data;
}
