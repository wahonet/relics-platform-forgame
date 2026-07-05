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
    counties: string[];
    townships: string[];
    /** 拥有档案/三维全量数据的县区(嘉祥县)。 */
    full_tier_county?: string;
  };
  features: {
    ai_chat: boolean;
    models_3d: boolean;
    patrol: boolean;
    catalog: boolean;
    amap_route?: boolean;
  };
  cesium_ion_token?: string;
  ai_chat?: {
    enabled: boolean;
    default_model?: string;
    available_models?: { id: string; name: string }[];
  };
  stats: {
    relics_total: number;
    full_tier_total?: number;
    has_3d_count?: number;
  };
  auth?: {
    enabled: boolean;
  };
}

interface Window {
  __PLATFORM_CONFIG?: PlatformConfig;
}
