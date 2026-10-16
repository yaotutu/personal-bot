import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createDataLayout, type DataLayout } from "../storage/data-layout.js";
import type { Config } from "../../config/load-config.js";

const digest = (text: string) => createHash("sha256").update(text).digest();
export async function createAuth(
  config: Config,
  layout: DataLayout = createDataLayout(config.dataDir),
) {
  const path = layout.authKeyFile;
  // 工作区登录密钥与模型凭据分离；只持久化随机签名密钥，让重启后的 token 继续有效。
  let secret: Buffer;
  try {
    secret = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    secret = randomBytes(32);
    await writeFile(path, secret, { mode: 0o600, flag: "wx" });
  }
  // 更换工作区访问密钥后，旧 token 立即失效；不把访问密钥自身写到磁盘。
  const signingKey = createHmac("sha256", secret)
    .update(config.accessKey || "")
    .digest();
  const sign = (payload: string) =>
    createHmac("sha256", signingKey).update(payload).digest("base64url");
  return {
    login: (key?: string) => {
      if (
        config.accessKey &&
        !timingSafeEqual(digest(key || ""), digest(config.accessKey))
      )
        return undefined;
      // 本机单用户场景下重新登录没有安全收益（签名密钥 + accessKey 已经控访问），
      // 因此签发的 token 不再设硬过期：旧 token（payload 里 exp 是 +24h）继续按原 24h 到期时间被 authorized() 拒绝，
      // 新 token 的 exp 写为 MAX_SAFE_INTEGER，data.exp > Date.now() 永远成立。作废仍交给 accessKey 轮换触发签名密钥变化。
      const payload = Buffer.from(
        JSON.stringify({
          owner: "local-user",
          exp: Number.MAX_SAFE_INTEGER,
          nonce: randomBytes(12).toString("hex"),
        }),
      ).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },
    authorized: (authorization?: string | null) => {
      if (!authorization?.startsWith("Bearer ")) return false;
      const parts = authorization.slice(7).split(".");
      if (
        parts.length !== 2 ||
        !timingSafeEqual(digest(parts[1]!), digest(sign(parts[0]!)))
      )
        return false;
      try {
        const data = JSON.parse(
          Buffer.from(parts[0]!, "base64url").toString(),
        ) as { owner?: string; exp?: number };
        return (
          data.owner === "local-user" &&
          typeof data.exp === "number" &&
          data.exp > Date.now()
        );
      } catch {
        return false;
      }
    },
  };
}
