import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolvedAddress = { address: string; family: number };

const blocked = new BlockList();
for (const [subnet, bits, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const) blocked.addSubnet(subnet, bits, family);

const normalizeIp = (value: string) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value)?.[1];
  return mapped ?? value;
};

const isPublicIp = (value: string) => {
  const ip = normalizeIp(value);
  const family = isIP(ip);
  return family !== 0 && !blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
};

/**
 * 解析并校验主机地址。web_fetch 与 browser 共用这份基础地址规则，
 * 但两个业务域互不引用；浏览器独立搬运时携带或替换该 shared 工具均可。
 * allowPrivateTargets 只放宽回环/私网限制，仍要求合法 IP/主机名。
 */
export const resolvePublicHost = async (
  hostname: string,
  allowPrivateTargets = false,
  signal?: AbortSignal,
): Promise<ResolvedAddress> => {
  signal?.throwIfAborted();
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (!allowPrivateTargets) {
    if (unbracketed === "localhost" || unbracketed.endsWith(".localhost"))
      throw new Error("Blocked local hostname");
  }
  const ipFamily = isIP(unbracketed);
  if (ipFamily) {
    if (!allowPrivateTargets && !isPublicIp(unbracketed))
      throw new Error("Blocked private address");
    return { address: unbracketed, family: ipFamily };
  }
  // 系统 getaddrinfo 无取消接口；停止等待后丢弃迟到结果，不继续发起调用。
  const lookup = dnsLookup(unbracketed, { all: true, verbatim: true });
  let abortLookup: (() => void) | undefined;
  const addresses = await (signal ? Promise.race([
    lookup,
    new Promise<never>((_resolve, reject) => {
      abortLookup = () => reject(signal.reason);
      signal.addEventListener("abort", abortLookup, { once: true });
      if (signal.aborted) abortLookup();
    }),
  ]).finally(() => { if (abortLookup) signal.removeEventListener("abort", abortLookup); }) : lookup);
  signal?.throwIfAborted();
  if (!addresses.length) throw new Error("DNS unavailable");
  // 每个解析结果都必须满足当前策略；调用方可固定使用第一个结果，避免二次解析漂移。
  if (!allowPrivateTargets)
    for (const address of addresses)
      if (!isPublicIp(address.address)) throw new Error("Blocked private address");
  return addresses[0]!;
};
