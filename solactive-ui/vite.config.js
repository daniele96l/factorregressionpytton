import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api/yahoo": {
        target: "https://query2.finance.yahoo.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ""),
      },
      "/api/fred": {
        target: "https://fred.stlouisfed.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fred/, ""),
      },
      "/api/stooq": {
        target: "https://stooq.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/stooq/, ""),
      },
    },
  },
});
