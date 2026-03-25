/**
 * auth.ts — Cloudflare Access JWT validation for piccolo-web-gateway.
 *
 * Validates the CF Access JWT from the request header or cookie.
 * Returns the authenticated userId (JWT `sub` claim) on success, or null on failure.
 *
 * Production auth flow:
 *   1. Extract JWT from `CF-Access-Jwt-Assertion` header or `CF_Authorization` cookie.
 *   2. Verify JWT signature against CF Access public keys at:
 *      `https://{team}.cloudflareaccess.com/cdn-cgi/access/certs`
 *   3. Return `payload.sub` as userId.
 *
 * Development / test escape hatch:
 *   When `AUTH_SECRET` is set in env and the request carries an
 *   `X-Dev-Auth: {AUTH_SECRET}` header, the `X-Dev-User-Id` header is returned
 *   as the userId without JWT validation.
 *   NEVER set AUTH_SECRET in production.
 *
 * Spec ref: specs/web_gateway.md §Auth
 */

/** Claim shape of a Cloudflare Access JWT payload. */
interface CfAccessJwtPayload {
  sub: string;
  email?: string;
  iss: string;
  aud: string[] | string;
  exp: number;
  iat: number;
}

/**
 * Validate the Cloudflare Access JWT attached to the request.
 *
 * Returns the userId (JWT `sub` claim) on success, or null if:
 *   - No JWT is present
 *   - JWT is expired or has an invalid signature
 *   - JWT payload is missing `sub`
 *
 * @param request The incoming HTTP or WebSocket upgrade request.
 * @param env     The Worker environment (for AUTH_SECRET dev escape hatch).
 */
export async function authenticateUser(request: Request, env: Env): Promise<string | null> {
  // ── Development / test escape hatch ──────────────────────────────────────────
  // Allows local testing without a real CF Access setup.
  // AUTH_SECRET must NEVER be set in production.
  if (env.AUTH_SECRET) {
    // Check X-Dev-Auth header (used by integration tests via devAuthHeaders())
    const devAuth = request.headers.get("x-dev-auth");
    if (devAuth === env.AUTH_SECRET) {
      const userId = request.headers.get("x-dev-user-id");
      return userId ?? null;
    }
    // Check URL query parameters (used by the browser SPA in dev mode —
    // capnweb's newWebSocketRpcSession does not support custom WS headers,
    // so dev credentials are passed as ?devAuth=...&devUserId=... query params).
    const url = new URL(request.url);
    const qDevAuth = url.searchParams.get("devAuth");
    if (qDevAuth === env.AUTH_SECRET) {
      return url.searchParams.get("devUserId") ?? null;
    }
  }

  // ── Extract JWT ───────────────────────────────────────────────────────────────
  let jwt: string | null = null;

  // Try standard CF Access header first
  jwt = request.headers.get("cf-access-jwt-assertion");

  // Fall back to cookie
  if (!jwt) {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const match = /CF_Authorization=([^;]+)/.exec(cookieHeader);
    jwt = match?.[1] ?? null;
  }

  if (!jwt) return null;

  // ── Verify JWT ────────────────────────────────────────────────────────────────
  try {
    const payload = await verifyJwt(jwt);
    if (!payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Verify a CF Access JWT.
 *
 * This implementation uses the Web Crypto API (available in Workers) to
 * verify the RS256 signature against the CF Access public key set.
 *
 * In test environments the JWT is a dev-auth escape hatch and this function
 * is not called (handled above).
 *
 * Spec ref: specs/web_gateway.md §Auth
 */
async function verifyJwt(jwt: string): Promise<CfAccessJwtPayload> {
  // Split JWT into header, payload, signature
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // Decode payload
  const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(payloadJson) as CfAccessJwtPayload;

  // Verify expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("JWT expired");

  // Decode header to get kid (key ID)
  const headerJson = atob(headerB64.replace(/-/g, "+").replace(/_/g, "/"));
  const header = JSON.parse(headerJson) as { alg: string; kid: string };

  // Fetch CF Access public keys (the team domain is in the issuer)
  const teamDomain = extractTeamDomain(payload.iss);
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  const certsRes = await fetch(certsUrl);
  if (!certsRes.ok) throw new Error(`Failed to fetch CF Access certs: ${certsRes.status}`);

  const certs = (await certsRes.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = certs.keys.find((k) => k.kid === header.kid) ?? certs.keys[0];
  if (!jwk) throw new Error("No matching public key found");

  // Import key and verify signature
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = Uint8Array.from(atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, dataToVerify);
  if (!valid) throw new Error("JWT signature invalid");

  return payload;
}

/**
 * Extract the team domain from a CF Access JWT issuer claim.
 * Issuer is typically `https://{team}.cloudflareaccess.com`
 */
function extractTeamDomain(iss: string): string {
  // Strip trailing slash if present
  return iss.replace(/\/$/, "");
}
