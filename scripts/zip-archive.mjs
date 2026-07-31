import fs from "node:fs";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const ZIP32_MAX = 0xffff_ffff;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const DEFLATE_METHOD = 8;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01, the earliest ZIP timestamp.

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function updateCrc32(current, chunk) {
  let value = current;
  for (const byte of chunk) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function normalizeEntryName(value) {
  const name = String(value || "").replaceAll("\\", "/");
  if (!name || name.startsWith("/") || name.includes("../") || name === "..") {
    throw new Error(`unsafe ZIP entry name: ${value}`);
  }
  return name;
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function localHeader(nameLength) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x0403_4b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 6);
  header.writeUInt16LE(DEFLATE_METHOD, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt16LE(nameLength, 26);
  return header;
}

function dataDescriptor({ crc32, compressedSize, uncompressedSize }) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x0807_4b50, 0);
  descriptor.writeUInt32LE(crc32, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  return descriptor;
}

function centralHeader(record) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x0201_4b50, 0);
  header.writeUInt16LE(0x031e, 4); // ZIP 3.0, created on Unix.
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 8);
  header.writeUInt16LE(DEFLATE_METHOD, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(record.crc32, 16);
  header.writeUInt32LE(record.compressedSize, 20);
  header.writeUInt32LE(record.uncompressedSize, 24);
  header.writeUInt16LE(record.name.length, 28);
  header.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  header.writeUInt32LE(record.localOffset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x0605_4b50, 0);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  return footer;
}

function assertZip32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX) {
    throw new Error(`${label} exceeds the ZIP32 limit`);
  }
}

/**
 * Creates a deterministic ZIP archive without buffering the large runtime
 * binaries in memory. This writer intentionally supports only the small,
 * flat set of regular files needed by the AI runtime release.
 */
export async function createZipArchive(entries, outputPath) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("at least one ZIP entry is required");
  }
  if (entries.length > 0xffff) throw new Error("too many ZIP entries");

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const output = fs.createWriteStream(outputPath, { flags: "wx" });
  const records = [];
  let outputOffset = 0;

  try {
    for (const entry of entries) {
      const sourcePath = path.resolve(entry.sourcePath);
      const source = await fs.promises.stat(sourcePath);
      if (!source.isFile()) throw new Error(`ZIP source is not a file: ${sourcePath}`);
      assertZip32(source.size, `ZIP source ${sourcePath}`);

      const name = Buffer.from(normalizeEntryName(entry.name), "utf8");
      if (name.length > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.name}`);
      const localOffset = outputOffset;
      const header = localHeader(name.length);
      await writeChunk(output, header);
      await writeChunk(output, name);
      outputOffset += header.length + name.length;

      let crc = 0xffff_ffff;
      let uncompressedSize = 0;
      let compressedSize = 0;
      const checksum = new Transform({
        transform(chunk, _encoding, callback) {
          crc = updateCrc32(crc, chunk);
          uncompressedSize += chunk.length;
          callback(null, chunk);
        },
      });
      const archiveSink = new Writable({
        write(chunk, _encoding, callback) {
          compressedSize += chunk.length;
          outputOffset += chunk.length;
          output.write(chunk, callback);
        },
      });
      await pipeline(
        fs.createReadStream(sourcePath),
        checksum,
        zlib.createDeflateRaw({ level: 9 }),
        archiveSink,
      );

      assertZip32(uncompressedSize, `uncompressed size for ${entry.name}`);
      assertZip32(compressedSize, `compressed size for ${entry.name}`);
      const record = {
        name,
        localOffset,
        crc32: (crc ^ 0xffff_ffff) >>> 0,
        compressedSize,
        uncompressedSize,
      };
      const descriptor = dataDescriptor(record);
      await writeChunk(output, descriptor);
      outputOffset += descriptor.length;
      records.push(record);
    }

    const centralOffset = outputOffset;
    for (const record of records) {
      const header = centralHeader(record);
      await writeChunk(output, header);
      await writeChunk(output, record.name);
      outputOffset += header.length + record.name.length;
    }
    const centralSize = outputOffset - centralOffset;
    assertZip32(centralOffset, "central directory offset");
    assertZip32(centralSize, "central directory size");
    await writeChunk(
      output,
      endOfCentralDirectory(records.length, centralSize, centralOffset),
    );
    await closeStream(output);
    return records.map((record) => ({
      name: record.name.toString("utf8"),
      crc32: record.crc32,
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
    }));
  } catch (error) {
    output.destroy();
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}
