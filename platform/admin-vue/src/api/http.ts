import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  AxiosError,
} from 'axios';
import { ElMessage } from 'element-plus';

// 统一 HTTP 客户端。
// 开发: Vite 代理 /api 到 FastAPI,cookie 同源。
// 生产: 挂在同域的 /admin-ui/ 下,本身就同源。
// 鉴权: FastAPI 使用 httponly cookie,必须开 `withCredentials: true`。
const http: AxiosInstance = axios.create({
  baseURL: '/',
  timeout: 30_000,
  withCredentials: true,
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
  },
});

// 响应拦截:401 清登录态并跳 /login;其它 4xx/5xx 提示 detail 并继续抛出。
http.interceptors.response.use(
  (res: AxiosResponse) => res,
  (error: AxiosError<{ detail?: string }>) => {
    const status = error.response?.status;
    const detail = error.response?.data?.detail || error.message || '请求失败';

    if (status === 401) {
      import('@/stores/auth').then(({ useAuthStore }) => {
        useAuthStore().clear();
      });
      // 登录页自身 401 不再重复跳转。
      const path = window.location.hash.replace('#', '');
      if (!path.startsWith('/login')) {
        window.location.hash = '#/login';
      }
    } else if (status === 409) {
      ElMessage.warning(detail);
    } else if (status && status >= 400) {
      ElMessage.error(detail);
    } else {
      ElMessage.error('网络异常：' + detail);
    }
    return Promise.reject(error);
  },
);

export async function get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.get<T>(url, config);
  return res.data;
}

export async function post<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await http.post<T>(url, data, config);
  return res.data;
}

export async function put<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await http.put<T>(url, data, config);
  return res.data;
}

export async function del<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.delete<T>(url, config);
  return res.data;
}

export default http;
