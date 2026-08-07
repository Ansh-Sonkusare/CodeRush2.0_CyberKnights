import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The gateway (:4000) is the single public entry point. The dev server proxies
// HTTP /api/* and the /ws WebSocket through to it so the browser only ever
// talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
      "/ws": { target: "http://127.0.0.1:4000", ws: true, changeOrigin: true },
    },
  },
});
