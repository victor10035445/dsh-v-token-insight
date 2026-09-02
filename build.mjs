/**
 * dsh-v-token-insight 客户端构建：
 * esbuild 把 src/client.jsx 打包成 factory 形式的 lib/client.js
 * （window.__ModuleLoader__.load 包裹；react / @deepseek-ai/* 全部 external，
 *  由 DSH client-modules 的引导基线提供，见 package.json 的 dsh.client.inject）。
 *
 * 与同品牌 V 系列插件同构，无虚拟模块；pricing.mjs / stats-fold.mjs /
 * charts.mjs 是零依赖纯函数模块，既被打进客户端包，也可在 node 下直接单测。
 */
import * as esbuild from "esbuild";

const banner = `window.__ModuleLoader__.load({ id: "dsh-v-token-insight", factory: (require) => {
"use strict";
var module = { exports: {} };
var exports = module.exports;`;

const footer = `return module.exports;
} });`;

await esbuild.build({
  entryPoints: ["src/client.jsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outfile: "lib/client.js",
  banner: { js: banner },
  footer: { js: footer },
  external: ["react", "react/jsx-runtime", "react-dom", "@deepseek-ai/*"],
  minify: true,
  legalComments: "none",
  logLevel: "info"
});
