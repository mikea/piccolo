/**
 * Tests for piccolo-web-gateway.
 *
 * Spec ref: specs/web_gateway.md §IWebGateway
 */

import { describe, expect, it } from "vitest";
import { WebGatewayImpl } from "../src/web-gateway.ts";
import { createMockCore, createMockUser } from "./mocks/piccolo-core.ts";

function makeGateway(userId = "test-user-id") {
  const user = createMockUser();
  const core = createMockCore(user);
  const gateway = new WebGatewayImpl(core, userId);
  return { gateway, core, user };
}

describe("WebGatewayImpl", () => {
  it("getUser() calls core.getUser with the gateway userId", () => {
    const { gateway, core } = makeGateway("alice");
    gateway.getUser();
    expect(core.getUser).toHaveBeenCalledWith("alice");
  });

  it("getUser() returns the IUser stub from core", () => {
    const { gateway, user } = makeGateway();
    const result = gateway.getUser();
    expect(result).toBe(user);
  });

  it("different userIds produce distinct getUser() calls", () => {
    const core = createMockCore();
    const gw1 = new WebGatewayImpl(core, "user-1");
    const gw2 = new WebGatewayImpl(core, "user-2");
    gw1.getUser();
    gw2.getUser();
    expect(core.getUser).toHaveBeenCalledWith("user-1");
    expect(core.getUser).toHaveBeenCalledWith("user-2");
  });
});
