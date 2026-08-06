// 流式 SHA-256：对 .ewpart 这类大文件做增量校验，避免一次性载入内存。
//
// PLAN.md 要求"完成后从磁盘分片文件进行流式 SHA-256 校验"。Web Crypto 的
// subtle.digest 只接受完整 buffer，256 MB 全量载入会击穿接收端 192 MB 堆
// 目标，因此这里用纯 JS 实现 FIPS 180-4 的增量版（标准实现，无依赖）。
//
// 黄金向量："abc" → ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private totalLen = 0; // 已处理字节数（含缓冲）
  private buf = new Uint8Array(64);
  private bufLen = 0;

  /** 喂入一块数据（任意长度）。 */
  update(data: Uint8Array): void {
    this.totalLen += data.length;
    let offset = 0;
    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      offset = take;
      if (this.bufLen === 64) {
        this.compress(this.buf);
        this.bufLen = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.compress(data.subarray(offset, offset + 64));
      offset += 64;
    }
    const rest = data.length - offset;
    if (rest > 0) {
      this.buf.set(data.subarray(offset), 0);
      this.bufLen = rest;
    }
  }

  /** 结束并输出 32 字节摘要。调用后实例不可再用。 */
  digest(): Uint8Array {
    // 标准 padding：0x80 → 零填充至 56 mod 64 → 8 字节大端 64 位总位长。
    const bitLenHi = Math.floor(this.totalLen / 2 ** 29) >>> 0; // 位长高 32 位（字节长×8，256MB 级远小于 2^32 字节，此值恒 0 但保留）
    const bitLenLo = (this.totalLen * 8) >>> 0;
    const padTotal =
      this.bufLen < 56 ? 56 - this.bufLen : 64 + 56 - this.bufLen;
    const pad = new Uint8Array(padTotal + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(padTotal, bitLenHi, false);
    dv.setUint32(padTotal + 4, bitLenLo, false);
    this.update(pad);

    const out = new Uint8Array(32);
    const outDv = new DataView(out.buffer);
    outDv.setUint32(0, this.h0 >>> 0, false);
    outDv.setUint32(4, this.h1 >>> 0, false);
    outDv.setUint32(8, this.h2 >>> 0, false);
    outDv.setUint32(12, this.h3 >>> 0, false);
    outDv.setUint32(16, this.h4 >>> 0, false);
    outDv.setUint32(20, this.h5 >>> 0, false);
    outDv.setUint32(24, this.h6 >>> 0, false);
    outDv.setUint32(28, this.h7 >>> 0, false);
    return out;
  }

  private compress(block: Uint8Array): void {
    const w = new Uint32Array(64);
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** 一次性计算（小数据便捷入口；大数据请用增量 update）。 */
export function sha256Once(bytes: Uint8Array): Uint8Array {
  const h = new Sha256();
  h.update(bytes);
  return h.digest();
}

export function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256Once(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
