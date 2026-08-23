import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        gone: resolve(__dirname, "gone.html"),
      },
      output: {
        manualChunks: {
          monaco: ["monaco-editor", "@monaco-editor/react"],
          markdown: [
            "unified",
            "remark-parse",
            "remark-gfm",
            "remark-frontmatter",
            "remark-math",
            "remark-rehype",
            "rehype-katex",
            "rehype-highlight",
            "rehype-sanitize",
            "rehype-stringify",
            "katex",
            "highlight.js",
          ],
          vendor: ["react", "react-dom", "yjs"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/socket": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
});
