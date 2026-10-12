
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { transform as transformCss } from "lightningcss";
import { readFile } from "node:fs/promises";
import path from "node:path";

function inlineNodeModulesAssets() {
  let root;
  let nodeModulesRoot;

  const inside = (parent, file) => {
    const relative = path.relative(parent, file);
    return (
      relative === "" ||
      (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
    );
  };

  const attribute = (tag, name) => {
    const match = tag.match(
      new RegExp(
        `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
                 "i",
      ),
    );
    return match?.slice(1).find((v) => v !== undefined);
  };

  async function replaceMatches(html, regex, handler) {
    const matches = [...html.matchAll(regex)];

    for (const match of matches.reverse()) {
      const replacement = await handler(match[0]);

      if (replacement != null) {
        html =
        html.slice(0, match.index) +
        replacement +
        html.slice(match.index + match[0].length);
      }
    }

    return html;
  }

  async function inlineCssUrls(css, cssFile) {
    const regex =
    /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
    const matches = [...css.matchAll(regex)];

    const mimeTypes = {
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".eot": "application/vnd.ms-fontobject",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };

    for (const match of matches.reverse()) {
      const url = (match[2] ?? match[3] ?? "").trim();

      if (
        !url ||
        /^(?:data:|https?:|\/\/|#|blob:|var\()/i.test(url) ||
        url.startsWith("/")
        ) {
          continue;
        }

        const pathname = decodeURIComponent(url.split(/[?#]/, 1)[0]);
      if (!pathname) continue;

          const file = path.resolve(path.dirname(cssFile), pathname);

      if (!inside(nodeModulesRoot, file)) continue;

          let bytes;
      try {
        bytes = await readFile(file);
      } catch (error) {
        throw new Error(
          `Cannot inline CSS asset "${url}" from "${cssFile}": ${error.message}`,
        );
      }

      const mime =
      mimeTypes[path.extname(file).toLowerCase()] ??
      "application/octet-stream";
        const hashIndex = url.indexOf("#");
        const fragment = hashIndex < 0 ? "" : url.slice(hashIndex);

        const replacement =
        `url("data:${mime};base64,${bytes.toString("base64")}${fragment}")`;

        css =
        css.slice(0, match.index) +
        replacement +
        css.slice(match.index + match[0].length);
    }

    return css;
  }

  async function inlineAsset(url, type) {
    const relativePath = decodeURIComponent(
      url.slice("/node_modules/".length).split(/[?#]/, 1)[0],
    );
    const file = path.resolve(nodeModulesRoot, relativePath);

    if (!inside(nodeModulesRoot, file)) {
      throw new Error(`Invalid node_modules asset path: ${url}`);
    }

    let contents = await readFile(file, "utf8");

    if (type === "css") {
      contents = await inlineCssUrls(contents, file);
      contents = transformCss({
        filename: file,
        code: Buffer.from(contents),
                              minify: true,
      }).code.toString();

      return `<style>${contents.replace(/<\/style/gi, "<\\/style")}</style>`;
    }

    return `<script>${contents.replace(/<\/script/gi, "<\\/script")}</script>`;
  }

  return {
    name: "inline-node-modules-assets",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
      nodeModulesRoot = path.resolve(root, "node_modules");
    },

    transformIndexHtml: {
      order: "pre",

      async handler(html) {
        html = await replaceMatches(
          html,
          /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
          async (tag) => {
            const src = attribute(tag, "src");
            return src?.startsWith("/node_modules/")
            ? inlineAsset(src, "js")
            : null;
          },
        );

        html = await replaceMatches(
          html,
          /<link\b[^>]*>/gi,
          async (tag) => {
            const href = attribute(tag, "href");
            const rel = (attribute(tag, "rel") ?? "")
            .toLowerCase()
            .split(/\s+/);

            return rel.includes("stylesheet") &&
            href?.startsWith("/node_modules/")
            ? inlineAsset(href, "css")
            : null;
          },
        );

        return html;
      },
    },
  };
}

export default defineConfig({
  plugins: [
    inlineNodeModulesAssets(),
                            viteSingleFile({ removeViteModuleLoader: true }),
  ],

  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },

  preview: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },

  build: {
    target: "esnext",
    reportCompressedSize: false,
    cssMinify: "lightningcss",
  },
});
