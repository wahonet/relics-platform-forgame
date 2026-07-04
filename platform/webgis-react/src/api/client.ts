import axios, { type AxiosInstance } from "axios";

const baseURL = "";

export const apiClient: AxiosInstance = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 30000,
});

apiClient.interceptors.response.use(
  (resp) => resp,
  (err) => {
    if (err?.response?.status === 401 && !location.hash.includes("login")) {
      location.hash = "/login";
    }
    return Promise.reject(err);
  },
);
