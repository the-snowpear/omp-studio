import { resolve } from "node:path";
import { defineConfig } from "vite";

const page = (name: string) => resolve(import.meta.dirname, name);

export default defineConfig({
  base: "./",
  server: { port: 5190, strictPort: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        index: page("index.html"),
        a: page("a/index.html"),
        b: page("b/index.html"),
        c: page("c/index.html"),
      },
    },
  },
});
