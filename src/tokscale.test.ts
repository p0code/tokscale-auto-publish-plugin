import { describe, expect, it } from "vite-plus/test";

import { deviceIdFor, normalizeApiUrl, tokscaleClient } from "./tokscale.ts";

describe("tokscale", () => {
  it("maps only providers Tokscale accepts", () => {
    expect(tokscaleClient("claude")).toBe("claude");
    expect(tokscaleClient("antigravity")).toBe("antigravity");
    expect(tokscaleClient("muse")).toBeNull();
    expect(tokscaleClient("__proto__")).toBeNull();
  });

  it("derives a stable device id that Tokscale accepts and that hides the environment id", () => {
    const id = deviceIdFor("env-123");
    expect(id).toBe(deviceIdFor("env-123"));
    expect(id).not.toBe(deviceIdFor("env-124"));
    expect(id).toMatch(/^[A-Za-z0-9._:-]{1,96}$/);
    expect(id).not.toContain("env-123");
  });

  it("only talks to HTTPS origins, or plain HTTP on this machine", () => {
    expect(normalizeApiUrl("https://tokscale.ai/some/path")).toBe("https://tokscale.ai");
    expect(normalizeApiUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeApiUrl("http://tokscale.ai")).toBeNull();
    expect(normalizeApiUrl("not a url")).toBeNull();
  });
});
