import { networkInterfaces } from "node:os";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const UNSPECIFIED_BINDS = new Set(["0.0.0.0", "::", "[::]"]);

export function normalizeStudioHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeStudioHost(hostname);
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

export function isUnspecifiedBindHost(hostname: string): boolean {
  return UNSPECIFIED_BINDS.has(normalizeStudioHost(hostname));
}

export function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((segment) => Number.parseInt(segment, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = normalizeStudioHost(hostname);
  if (isLoopbackHost(host) || isUnspecifiedBindHost(host)) return true;
  if (host === "host.docker.internal" || host.endsWith(".local")) return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  return isPrivateIpv4(host);
}

export function isPermittedStudioRequestHost(
  requestHost: string,
  bindHostname: string,
  extraHosts: ReadonlySet<string> = new Set(),
): boolean {
  const host = normalizeStudioHost(requestHost);
  const bind = normalizeStudioHost(bindHostname) || "127.0.0.1";
  const extras = new Set([...extraHosts].map((item) => normalizeStudioHost(item)));
  if (extras.has(host)) return true;
  if (isLoopbackHost(bind)) return isLoopbackHost(host);
  return isPrivateOrLocalHostname(host) || host === bind;
}

export function publicOriginFromRequest(url: string, hostHeader?: string): string {
  const parsed = new URL(url);
  const host = hostHeader?.split(",")[0]?.trim() || parsed.host;
  return `${parsed.protocol}//${host}`;
}

function lanAddressRank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (ip.startsWith("172.")) return 2;
  return 3;
}

export function listLanIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      const family = addr.family;
      const ipv4 = family === "IPv4" || family === 4;
      if (!ipv4 || addr.internal || addr.address.startsWith("169.254.")) continue;
      addresses.push(addr.address);
    }
  }
  return [...new Set(addresses)].sort((left, right) => lanAddressRank(left) - lanAddressRank(right) || left.localeCompare(right));
}

export function resolveLegadoOrigin(requestOrigin: string, lanAddresses: readonly string[] = listLanIpv4Addresses()): string {
  const url = new URL(requestOrigin);
  if (isLoopbackHost(url.hostname) || isUnspecifiedBindHost(url.hostname)) {
    const lan = lanAddresses[0];
    if (lan) {
      url.hostname = lan;
      return url.origin;
    }
  }
  return url.origin;
}

export function formatStudioListenBanner(input: {
  readonly hostname: string;
  readonly port: number;
  readonly lanAddresses: readonly string[];
}): string {
  const lines = [`InkOS Studio running on http://${input.hostname}:${input.port}`];
  const hosts = input.lanAddresses.length > 0
    ? input.lanAddresses
    : (isLoopbackHost(input.hostname) || isUnspecifiedBindHost(input.hostname) ? ["127.0.0.1"] : [input.hostname]);
  for (const ip of hosts) {
    lines.push(`Legado 书源: http://${ip}:${input.port}/api/v1/legado.json`);
  }
  if (isUnspecifiedBindHost(input.hostname)) {
    lines.push("LAN bind is enabled. Use this only on a trusted network.");
  }
  return lines.join("\n");
}
