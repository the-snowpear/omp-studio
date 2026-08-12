import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// P0 renderer: a pure browser build with no host-specific coupling. The
// relative base keeps the same bundle loadable from any origin the shell
// later serves it from (including file:// during early desktop bring-up).
export default defineConfig({
  plugins: [react()],
  base: "./",
});
