import { post } from './http';

export interface LoginBody {
  username: string;
  password: string;
}

export interface LoginResp {
  ok: boolean;
}

// 成功会让后端下发 httponly cookie `session=authenticated`，浏览器自动携带。
// 失败（401）会被拦截器 toast 出来，业务层 catch 住即可。
export function login(body: LoginBody): Promise<LoginResp> {
  return post<LoginResp>('/api/login', body);
}
