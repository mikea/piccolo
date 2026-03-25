/**
 * assets.ts — Static file serving for piccolo-web-gateway.
 *
 * Serves two kinds of static content from the ASSETS R2 bucket:
 *   1. SPA shell:  GET /  → R2 key "index.html"
 *   2. Component modules: GET /components/{id}.js → R2 key "components/{id}.js"
 *
 * Both paths return 404 if the R2 key is missing.
 *
 * Spec ref: specs/web_gateway.md §Deployment, §IWebUI — Component loading
 */

/**
 * Serve the browser SPA shell.
 *
 * Returns the contents of R2 key "index.html" as text/html.
 * Returns 404 if the key does not exist (SPA not yet deployed to R2).
 */
export async function serveSpaShell(env: Env): Promise<Response> {
  const obj = await env.ASSETS.get("index.html");
  if (!obj) {
    return new Response("SPA not deployed", { status: 404 });
  }
  return new Response(obj.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

/**
 * Serve a custom tool UI component module.
 *
 * Maps GET /components/{componentId}.js → R2 key "components/{componentId}.js".
 * Returns the module as application/javascript.
 * Returns 404 if the key does not exist.
 *
 * @param pathname The request pathname, e.g. "/components/r2-file-tree.js"
 */
export async function serveComponent(pathname: string, env: Env): Promise<Response> {
  // Strip leading slash to form the R2 key
  const key = pathname.slice(1); // "components/{id}.js"

  // Basic validation — only allow component JS files
  if (!/^components\/[a-zA-Z0-9_-]+\.js$/.test(key)) {
    return new Response("Not Found", { status: 404 });
  }

  const obj = await env.ASSETS.get(key);
  if (!obj) {
    return new Response("Component not found", { status: 404 });
  }

  return new Response(obj.body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
