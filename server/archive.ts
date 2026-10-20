import { AppError } from "./errors.ts";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Standard UTF-8 ZIP, STORE compression. Limits bound memory and avoid ZIP64. */
export function zipEntries(entries: { name: string; data: Buffer }[]): Buffer {
  if (!entries.length || entries.length > 200)
    throw new AppError(400, "每个下载包支持 1–200 个文件");
  if (entries.reduce((n, e) => n + e.data.length, 0) > 500 * 1024 * 1024)
    throw new AppError(413, "下载包超过 500MB，请分批下载");
  const names = new Set<string>(),
    locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = entry.name.replace(/\\/g, "/");
    if (
      raw.startsWith("/") ||
      raw.split("/").some((p) => p === "..") ||
      /[\x00-\x1f]/.test(raw)
    )
      throw new AppError(400, "下载包文件名无效");
    const name = Buffer.from(raw);
    if (!name.length || name.length > 500 || names.has(raw))
      throw new AppError(400, "下载包包含无效或重复文件名");
    names.add(raw);
    const crc = crc32(entry.data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    directory.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
