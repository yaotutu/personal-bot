import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// dev 代理让 Web 与服务端同源，避免 CORS 与环境切换；构建产物可直接由服务端托管。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // API 目标可用环境变量覆盖；默认 8787，被占用时 API_TARGET=http://127.0.0.1:8790
    proxy: { "/api": process.env.API_TARGET ?? "http://127.0.0.1:8787" },
  },
});
