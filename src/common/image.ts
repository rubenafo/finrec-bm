// Recognises the image formats models accept (PNG, JPEG, GIF, WebP) from
// their first bytes, with their size in pixels.

export interface ImageInfo {
  format: "png" | "jpeg" | "gif" | "webp";
  width: number;
  height: number;
}

/** The image's format and size, or undefined when it isn't a PNG, JPEG, GIF or WebP image. */
export function imageInfo(data: Buffer): ImageInfo | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString("latin1", 0, 6))) {
    return { format: "gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 30 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return { format: "webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { format: "webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    return undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // The size is in the first start-of-frame segment (SOF0 to SOF15, except DHT, JPG and DAC).
    for (let at = 2; at + 9 <= data.length && data[at] === 0xff; ) {
      const marker = data[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: "jpeg", width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  return undefined;
}
