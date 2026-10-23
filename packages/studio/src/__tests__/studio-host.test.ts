import { describe, expect, it } from "vitest";
import {
  formatStudioListenBanner,
  isPermittedStudioRequestHost,
  resolveLegadoOrigin,
} from "../api/studio-host.js";

describe("studio host policy", () => {
  it("keeps a loopback bind off the LAN", () => {
    expect(isPermittedStudioRequestHost("localhost", "127.0.0.1")).toBe(true);
    expect(isPermittedStudioRequestHost("192.168.1.8", "127.0.0.1")).toBe(false);
    expect(isPermittedStudioRequestHost("untrusted.example", "127.0.0.1")).toBe(false);
  });

  it("allows private LAN hosts when bound to all interfaces, but not public DNS names", () => {
    expect(isPermittedStudioRequestHost("192.168.1.8", "0.0.0.0")).toBe(true);
    expect(isPermittedStudioRequestHost("10.0.0.2", "0.0.0.0")).toBe(true);
    expect(isPermittedStudioRequestHost("127.0.0.1", "0.0.0.0")).toBe(true);
    expect(isPermittedStudioRequestHost("untrusted.example", "0.0.0.0")).toBe(false);
  });

  it("rewrites loopback import origins to a LAN address", () => {
    expect(resolveLegadoOrigin("http://127.0.0.1:4569", ["192.168.1.8"])).toBe("http://192.168.1.8:4569");
    expect(resolveLegadoOrigin("http://192.168.1.8:4569", ["10.0.0.2"])).toBe("http://192.168.1.8:4569");
  });

  it("prints the Legado import URL on listen", () => {
    expect(formatStudioListenBanner({
      hostname: "0.0.0.0",
      port: 4569,
      lanAddresses: ["192.168.1.8"],
    })).toContain("http://192.168.1.8:4569/api/v1/legado.json");
  });
});
