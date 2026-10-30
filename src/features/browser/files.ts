import {
  BrowserError,
  type BrowserUpload,
  type BrowserUploadFile,
} from "./types.js";

export const MAX_BROWSER_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_BROWSER_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_BROWSER_UPLOAD_FILES = 4;
export const BROWSER_FILE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;

const isBase64Alphabet = (code: number) =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47;

const isStrictBase64 = (value: string) => {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (!isBase64Alphabet(value.charCodeAt(index))) return false;
  }
  return true;
};

const decodedBase64Bytes = (value: string) => {
  if (!isStrictBase64(value))
    throw new BrowserError("INVALID_INPUT", "contentBase64 must be strict base64 without a data prefix");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

/** 下载名只保留单层 ASCII 文件名，避免网页提供的路径或特殊字符进入持久目录。 */
export const safeBrowserDownloadName = (value: string) => {
  const base = value.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 255);
  return cleaned || "download.bin";
};

/**
 * 上传规则在 feature 层收口：文件数量由真实 chooser 决定，内容只从请求
 * 中的内存字节解码；这里不接受路径，也不读写 workspace。
 */
export const decodeBrowserUploadFiles = (
  upload: BrowserUpload,
  files: readonly { name: string; mimeType: string; contentBase64: string }[],
): BrowserUploadFile[] => {
  const maxFiles = upload.multiple ? MAX_BROWSER_UPLOAD_FILES : 1;
  if (files.length < 1 || files.length > maxFiles)
    throw new BrowserError(
      "INVALID_INPUT",
      upload.multiple ? "Select between 1 and 4 files" : "Select exactly one file",
    );

  let totalBytes = 0;
  const decoded = files.map((file) => {
    if (!BROWSER_FILE_NAME_PATTERN.test(file.name))
      throw new BrowserError(
        "INVALID_INPUT",
        "File names may contain only ASCII letters, digits, dot, underscore and hyphen, and cannot start with a dot",
      );
    const bytes = decodedBase64Bytes(file.contentBase64);
    totalBytes += bytes;
    if (totalBytes > MAX_BROWSER_UPLOAD_BYTES)
      throw new BrowserError("PAYLOAD_TOO_LARGE", "Browser upload exceeds 8 MiB");
    return {
      name: file.name,
      mimeType: file.mimeType.trim() || "application/octet-stream",
      content: new Uint8Array(Buffer.from(file.contentBase64, "base64")),
    };
  });
  return decoded;
};
