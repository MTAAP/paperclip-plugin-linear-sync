// UI build script — bundles React components for the browser
import { build } from "esbuild";

await build({
  entryPoints: ["src/ui/index.tsx"],
  bundle: true,
  outdir: "dist/ui",
  format: "esm",
  jsx: "automatic",
  external: ["react", "react-dom"],
  minify: true,
});
