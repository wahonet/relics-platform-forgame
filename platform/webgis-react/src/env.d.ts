/// <reference types="vite/client" />

interface PlatformConfig {
  project: {
    name: string;
    full_name: string;
    data_cutoff?: string;
    data_source?: string;
  };
  geo: {
    center?: { lng: number; lat: number; alt?: number };
    bounds?: { west: number; south: number; east: number; north: number };
  };
  administrative: {
    county_name: string;
    townships: string[];
  };
  features: {
    ai_chat: boolean;
    worklog: boolean;
    models_3d: boolean;
    dem: boolean;
  };
  cesium_ion_token?: string;
  ai_chat?: {
    enabled: boolean;
    default_model?: string;
    available_models?: { id: string; name: string }[];
  };
  stats: {
    relics_total: number;
    has_3d_count?: number;
  };
  admin_ui?: {
    available: boolean;
    url: string;
  };
  auth?: {
    enabled: boolean;
  };
}

interface Window {
  __PLATFORM_CONFIG?: PlatformConfig;
}
