// 加密模块：PBKDF2-HMAC-SHA-256 派生 AES-256-GCM 密钥，逐段加密/解密。
//
// 设计（对应 PLAN.md "可选加密" 一节）：
// - 口令本身不参与协议：只在本地用于派生密钥。
// - 派生：PBKDF2-HMAC-SHA-256(passphrase, salt=16B 随机, iterations=600000, 32B)。
// - 每段 nonce = 8 字节随机前缀 ‖ u32LE(segmentIndex)，共 12 字节 GCM nonce；
//   8 字节前缀写入清单（随二维码光学传输），分段序号保证同传输内 nonce 唯一。
// - 加密在压缩之后（"压缩后加密"），密文输出 = ciphertext ‖ 16B GCM tag。
// - 口令不写入二维码、检查点或日志。

import { GCM_TAG_LEN, NONCE_PREFIX_LEN, SALT_LEN, PBKDF2_ITERATIONS } from "./ew-constants";

export { GCM_TAG_LEN, NONCE_PREFIX_LEN, SALT_LEN, PBKDF2_ITERATIONS };

/** 从口令派生 AES-256-GCM 密钥。同口令+同盐 → 同密钥（确定性）。
 *  @param extractable 是否允许导出密钥（默认 false；测试/调试可传 true）。 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
  extractable = false,
): Promise<CryptoKey> {
  if (salt.length !== SALT_LEN) throw new Error(`盐必须为 ${SALT_LEN} 字节`);
  if (!(iterations > 0 && Number.isInteger(iterations))) {
    throw new Error("PBKDF2 迭代次数必须是正整数");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
  return key;
}

/** 生成 16 字节随机盐。 */
export function randomSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LEN);
  crypto.getRandomValues(salt);
  return salt;
}

/** 生成 8 字节随机 nonce 前缀。 */
export function randomNoncePrefix(): Uint8Array {
  const prefix = new Uint8Array(NONCE_PREFIX_LEN);
  crypto.getRandomValues(prefix);
  return prefix;
}

/** 组合 12 字节 GCM nonce：8 字节前缀 ‖ u32LE(segmentIndex)。 */
export function buildNonce(noncePrefix: Uint8Array, segmentIndex: number): Uint8Array {
  if (noncePrefix.length !== NONCE_PREFIX_LEN) {
    throw new Error(`nonce 前缀必须为 ${NONCE_PREFIX_LEN} 字节`);
  }
  const nonce = new Uint8Array(12);
  nonce.set(noncePrefix, 0);
  new DataView(nonce.buffer).setUint32(8, segmentIndex >>> 0, true);
  return nonce;
}

/** 加密一段（压缩后调用）。返回密文 ‖ 16B tag 与本次使用的随机 nonce 前缀。 */
export async function encryptSegment(
  plain: Uint8Array,
  key: CryptoKey,
  segmentIndex: number,
  noncePrefix: Uint8Array = randomNoncePrefix(),
): Promise<{ data: Uint8Array; noncePrefix: Uint8Array }> {
  const nonce = buildNonce(noncePrefix, segmentIndex);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, tagLength: GCM_TAG_LEN * 8 },
    key,
    plain as BufferSource,
  );
  return { data: new Uint8Array(cipher), noncePrefix };
}

/**
 * 解密一段。口令错误或密文被篡改时 GCM 认证失败，抛出中文错误。
 * 注意：认证失败的消息故意不区分"口令错误"与"数据损坏"，避免给攻击者
 * 探测信息（两者对用户而言都是"无法恢复"）。
 */
export async function decryptSegment(
  cipher: Uint8Array,
  key: CryptoKey,
  segmentIndex: number,
  noncePrefix: Uint8Array,
): Promise<Uint8Array> {
  if (cipher.length <= GCM_TAG_LEN) {
    throw new Error("密文太短，无法解密");
  }
  const nonce = buildNonce(noncePrefix, segmentIndex);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: GCM_TAG_LEN * 8 },
      key,
      cipher as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error("解密失败：口令错误或数据已损坏");
  }
}
