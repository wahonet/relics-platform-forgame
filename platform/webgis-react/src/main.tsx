import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import LoginPage from "./pages/LoginPage";
import ModelViewerPage from "./pages/ModelViewerPage";
import PdfViewerPage from "./pages/PdfViewerPage";
import "./styles/globals.css";

// 资源概览/数据目录/系统管理均由 App 内部按标签渲染(共享 Header,地图常驻)。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/dashboard" element={<App />} />
        <Route path="/catalog" element={<App />} />
        <Route path="/admin" element={<App />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/model-viewer" element={<ModelViewerPage />} />
        <Route path="/pdf-viewer" element={<PdfViewerPage />} />
        <Route path="*" element={<App />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
