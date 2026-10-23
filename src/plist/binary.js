/**
 * Reader for Apple's binary property list format (`bplist00`).
 *
 * Coverage: null, bool, integers up to 128 bits (returned as Number when safe),
 * reals, dates, data, ASCII/UTF-8 and UTF-16BE strings, UIDs, arrays, sets and
 * dictionaries. Object graphs that contain cycles are returned with cycles
 * broken (the repeated reference yields the already-parsed object).
 */

export class BinaryPlistError extends Error {
  constructor(message) {
    super(message);
    this.name = "BinaryPlistError";
  }
}

function readUnsigned(buffer, offset, size) {
  if (size > 6) {
    // Read as BigInt and downcast when safe; sizes above 6 are unusual.
    let value = 0n;
    for (let i = 0; i < size; i += 1) value = (value << 8n) | BigInt(buffer[offset + i]);
    return Number(value);
  }
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buffer[offset + i];
  return value;
}

function readFloat(buffer, offset, size) {
  if (size === 4) return buffer.readFloatBE(offset);
  if (size === 8) return buffer.readDoubleBE(offset);
  throw new BinaryPlistError(`unsupported real width ${size}`);
}

export function parseBinaryPlist(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 40) throw new BinaryPlistError("file is too short to be a binary plist");
  if (buffer.toString("latin1", 0, 8) !== "bplist00") {
    throw new BinaryPlistError("missing bplist00 header");
  }

  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer[6];
  const referenceSize = trailer[7];
  const objectCount = readUnsigned(trailer, 8, 8);
  const topObject = readUnsigned(trailer, 16, 8);
  const offsetTableOffset = readUnsigned(trailer, 24, 8);

  if (offsetSize < 1 || referenceSize < 1) throw new BinaryPlistError("invalid trailer");
  if (objectCount === 0) throw new BinaryPlistError("plist has no objects");
  if (offsetTableOffset + objectCount * offsetSize > buffer.length) {
    throw new BinaryPlistError("offset table is out of bounds");
  }

  const offsets = new Array(objectCount);
  for (let i = 0; i < objectCount; i += 1) {
    offsets[i] = readUnsigned(buffer, offsetTableOffset + i * offsetSize, offsetSize);
  }
  const reference = (offset) => readUnsigned(buffer, offset, referenceSize);

  const cache = new Map();

  function parseLength(offset, info) {
    if (info !== 0x0f) return { length: info, contentOffset: offset + 1 };
    const marker = buffer[offset + 1];
    if (marker >> 4 !== 0x1) throw new BinaryPlistError("extended length is not an integer");
    const size = 1 << (marker & 0x0f);
    return {
      length: readUnsigned(buffer, offset + 2, size),
      contentOffset: offset + 2 + size,
    };
  }

  function parseObject(index) {
    if (cache.has(index)) return cache.get(index);
    if (index >= objectCount) throw new BinaryPlistError(`object reference ${index} out of range`);
    const offset = offsets[index];
    if (offset === undefined || offset >= buffer.length) {
      throw new BinaryPlistError(`object ${index} has an invalid offset`);
    }
    const marker = buffer[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;

    switch (type) {
      case 0x0:
        if (info === 0x0) return null;
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        throw new BinaryPlistError(`unsupported simple object 0x${marker.toString(16)}`);

      case 0x1: {
        if (info > 4) throw new BinaryPlistError("integer wider than 128 bits is unsupported");
        const size = 1 << info;
        const unsigned = readUnsigned(buffer, offset + 1, size);
        if (size === 16) return unsigned;
        if (size === 8) {
          const signed = buffer.readBigInt64BE(offset + 1);
          return Number(signed);
        }
        if (size === 1) return buffer.readInt8(offset + 1);
        if (size === 2) return buffer.readInt16BE(offset + 1);
        return buffer.readInt32BE(offset + 1);
      }

      case 0x2:
        return readFloat(buffer, offset + 1, 1 << info);

      case 0x3: {
        const seconds = buffer.readDoubleBE(offset + 1);
        return new Date(Date.UTC(2001, 0, 1) + seconds * 1000);
      }

      case 0x4: {
        const { length, contentOffset } = parseLength(offset, info);
        return Buffer.from(buffer.subarray(contentOffset, contentOffset + length));
      }

      case 0x5: {
        const { length, contentOffset } = parseLength(offset, info);
        return buffer.toString("utf8", contentOffset, contentOffset + length);
      }

      case 0x6: {
        const { length, contentOffset } = parseLength(offset, info);
        const units = new Array(length);
        for (let i = 0; i < length; i += 1) {
          units[i] = buffer.readUInt16BE(contentOffset + i * 2);
        }
        let result = "";
        for (let i = 0; i < units.length; i += 1) {
          result += String.fromCharCode(units[i]);
        }
        return result;
      }

      case 0x8: {
        const size = info + 1;
        return { $uid: readUnsigned(buffer, offset + 1, size) };
      }

      case 0xa:
      case 0xc: {
        const { length, contentOffset } = parseLength(offset, info);
        const array = [];
        cache.set(index, array);
        for (let i = 0; i < length; i += 1) {
          array.push(parseObject(reference(contentOffset + i * referenceSize)));
        }
        return array;
      }

      case 0xd: {
        const { length, contentOffset } = parseLength(offset, info);
        const object = {};
        cache.set(index, object);
        for (let i = 0; i < length; i += 1) {
          const key = parseObject(reference(contentOffset + i * referenceSize));
          const value = parseObject(
            reference(contentOffset + (length + i) * referenceSize),
          );
          object[String(key)] = value;
        }
        return object;
      }

      default:
        throw new BinaryPlistError(`unsupported object marker 0x${marker.toString(16)}`);
    }
  }

  return parseObject(topObject);
}
