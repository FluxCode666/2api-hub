import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * 渠道 API Key 加解密：AES-256-GCM，密文格式 v1:<iv b64>:<tag b64>:<cipher b64>
 * 密钥来自 APP_ENCRYPTION_KEY（64 位 hex）。
 */

function loadKey(hex = process.env.APP_ENCRYPTION_KEY): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('APP_ENCRYPTION_KEY 必须是 64 位 hex');
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string, keyHex?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(keyHex), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string, keyHex?: string): string {
  const [ver, iv, tag, data] = payload.split(':');
  if (ver !== 'v1' || !iv || !tag || !data) throw new Error('密文格式错误');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(keyHex), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** sk-abcdefgh1234 → sk-****1234 */
export function maskSecret(plain: string): string {
  const tail = plain.slice(-4);
  const dash = plain.indexOf('-');
  const prefix = dash > 0 && dash <= 6 ? plain.slice(0, dash + 1) : '';
  return `${prefix}****${tail}`;
}
