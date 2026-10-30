import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// 避开 Vite 默认端口 5173/4173，避免与其他前端项目或 Vite 预览冲突；服务端默认 12330/mock 17891。
const defaultApiTarget = "http://127.0.0.1:12330";

// dev 代理让 Web 与服务端同源，避免 CORS 与环境切换；构建产物可直接由服务端托管。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 15173,
    host: true,
    // API 目标可用环境变量覆盖；服务端默认端口 12330 已被占用时用 API_TARGET=http://127.0.0.1:<实际端口> pnpm --dir web dev
    proxy: { "/api": process.env.API_TARGET ?? defaultApiTarget },
  },
  // preview（构建产物验收）与 dev 共用同一代理配置。
  preview: {
    port: 14173,
    host: true,
    proxy: { "/api": process.env.API_TARGET ?? defaultApiTarget },
  },
});
