import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/canonical.js";
import { HttpAuthoritativeFabricReader } from "../src/security/gateway-reader.js";
import type { CommandContext, PermitClaims } from "../src/types.js";
import { baseClaims, testConfig } from "./helpers.js";

const authorizationPath = "/ledger/deals/DEAL-001/algorand-authorization";
const authorization = {
  schemaVersion: "1.0",
  dealId: "DEAL-001",
  lifecycleStatus: "ACTIVE",
  fabricTxId: "FABRIC-AUTH-001",
};

function commandAndClaims(): { command: CommandContext; claims: PermitClaims } {
  const command: CommandContext = {
    action: "pause",
    method: "POST",
    path: "/escrows/DEAL-001/pause",
    idempotencyKey: "EXECUTOR-PAUSE-001",
    body: null,
  };
  return {
    command,
    claims: {
      ...baseClaims(command, Math.floor(Date.now() / 1_000)),
      authoritativeReads: [{ path: authorizationPath, dataHash: sha256(authorization) }],
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function oidcConfig() {
  return testConfig({
    FABRIC_GATEWAY_BEARER_TOKEN: "",
    FABRIC_GATEWAY_OIDC_TOKEN_URL: "http://127.0.0.1:18080/realms/optiwork/protocol/openid-connect/token",
    FABRIC_GATEWAY_OIDC_CLIENT_ID: "optiwork-algorand-executor",
    FABRIC_GATEWAY_OIDC_CLIENT_SECRET: "executor-client-secret-test-only-0000001",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("authoritative Fabric Gateway OIDC", () => {
  it("accepts OAuth extension fields and caches one client-credentials token", async () => {
    let tokenRequests = 0;
    let fabricRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.pathname.endsWith("/protocol/openid-connect/token")) {
        tokenRequests += 1;
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toBe("grant_type=client_credentials");
        expect(String(new Headers(init?.headers).get("authorization"))).toMatch(/^Basic [A-Za-z0-9+/=]+$/u);
        return json({
          access_token: "oidc-access-token-0000000000000001",
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid profile",
          session_state: "keycloak-session-extension",
          "not-before-policy": 0,
        });
      }
      fabricRequests += 1;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oidc-access-token-0000000000000001");
      return json({ success: true, data: authorization, error: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reader = new HttpAuthoritativeFabricReader(oidcConfig());
    const { claims, command } = commandAndClaims();
    await expect(reader.readiness()).resolves.toBe(true);
    await reader.verifyCurrent(claims, command);
    await reader.verifyCurrent(claims, command);

    expect(tokenRequests).toBe(1);
    expect(fabricRequests).toBe(2);
  });

  it("uses singleflight refresh and compare-and-swap invalidation for concurrent stale-token 401s", async () => {
    let tokenRequests = 0;
    let refreshedFabricRequests = 0;
    const staleResponses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.pathname.endsWith("/protocol/openid-connect/token")) {
        tokenRequests += 1;
        return json({
          access_token: tokenRequests === 1
            ? "oidc-stale-access-token-00000001"
            : "oidc-fresh-access-token-00000001",
          token_type: "bearer",
          expires_in: 300,
        });
      }
      const authorizationHeader = new Headers(init?.headers).get("authorization");
      if (authorizationHeader === "Bearer oidc-stale-access-token-00000001") {
        return await new Promise<Response>((resolve) => staleResponses.push(resolve));
      }
      expect(authorizationHeader).toBe("Bearer oidc-fresh-access-token-00000001");
      refreshedFabricRequests += 1;
      return json({ success: true, data: authorization, error: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reader = new HttpAuthoritativeFabricReader(oidcConfig());
    const { claims, command } = commandAndClaims();
    const first = reader.verifyCurrent(claims, command);
    const second = reader.verifyCurrent(claims, command);
    for (let attempt = 0; attempt < 20 && staleResponses.length < 2; attempt += 1) await Promise.resolve();
    expect(staleResponses).toHaveLength(2);

    staleResponses[0]!(json({ success: false, data: null, error: { code: "UNAUTHORIZED" } }, 401));
    await first;
    expect(tokenRequests).toBe(2);
    staleResponses[1]!(json({ success: false, data: null, error: { code: "UNAUTHORIZED" } }, 401));
    await second;

    expect(tokenRequests).toBe(2);
    expect(refreshedFabricRequests).toBe(2);
  });

  it("fails readiness when the confidential client cannot obtain a valid token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      access_token: "too-short",
      token_type: "Bearer",
      expires_in: 300,
      error_extension: "must not weaken required-field validation",
    })));
    await expect(new HttpAuthoritativeFabricReader(oidcConfig()).readiness()).resolves.toBe(false);
  });
});
