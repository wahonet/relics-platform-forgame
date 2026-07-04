import { defineStore } from 'pinia';
import { adminApi, type CodesResp } from '@/api/admin';

// 后台各页面共用的编码字典。
// 首次 ensureLoaded() 从 /api/admin/codes 拉一次后常驻内存,
// 业务侧可用 `labelOf('category', '0300')` 取中文名。
interface State {
  loaded: boolean;
  loading: boolean;
  categories: Array<{ code: string; label: string }>;
  ranks: Array<{ code: string; label: string }>;
  searchTypes: Array<{ code: string; label: string }>;
}

export const useDictStore = defineStore('dict', {
  state: (): State => ({
    loaded: false,
    loading: false,
    categories: [],
    ranks: [],
    searchTypes: [],
  }),
  getters: {
    categoryMap: (s): Record<string, string> =>
      Object.fromEntries(s.categories.map(c => [c.code, c.label])),
    rankMap: (s): Record<string, string> =>
      Object.fromEntries(s.ranks.map(c => [c.code, c.label])),
    searchTypeMap: (s): Record<string, string> =>
      Object.fromEntries(s.searchTypes.map(c => [c.code, c.label])),
  },
  actions: {
    async ensureLoaded(force = false) {
      if (this.loaded && !force) return;
      if (this.loading) return;
      this.loading = true;
      try {
        const resp: CodesResp = await adminApi.codes();
        this.categories = resp.categories;
        this.ranks = resp.ranks;
        this.searchTypes = resp.search_types;
        this.loaded = true;
      } finally {
        this.loading = false;
      }
    },
    labelOf(kind: 'category' | 'rank' | 'search_type', code: string): string {
      if (!code) return '';
      if (kind === 'category') return this.categoryMap[code] ?? code;
      if (kind === 'rank') return this.rankMap[code] ?? code;
      return this.searchTypeMap[code] ?? code;
    },
  },
});
