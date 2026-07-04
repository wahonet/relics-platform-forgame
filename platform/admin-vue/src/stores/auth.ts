import { defineStore } from 'pinia';

// FastAPI 以 httponly cookie 为鉴权;前端读不到 cookie 值,
// 这里用 localStorage 做一个"是否登录"的软标记,供路由守卫与 UI 显示用户名。
// 真正的鉴权仍由 cookie 决定。
const LS_KEY = 'relics_admin_auth';

interface Persisted {
  authed: boolean;
  username: string;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { authed: false, username: '' };
    return JSON.parse(raw) as Persisted;
  } catch {
    return { authed: false, username: '' };
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => load(),
  actions: {
    setLoggedIn(username: string) {
      this.authed = true;
      this.username = username;
      localStorage.setItem(LS_KEY, JSON.stringify({ authed: true, username }));
    },
    clear() {
      this.authed = false;
      this.username = '';
      localStorage.removeItem(LS_KEY);
    },
  },
});
