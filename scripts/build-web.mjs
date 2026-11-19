// Bundles the client (public/js/app.js and its imports) into one minified file.
import { build } from "esbuild";

await build({
  entryPoints: ["public/js/app.js"],
  outfile: "public/dist/app.js",
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  sourcemap: false,
  logLevel: "info",
});
