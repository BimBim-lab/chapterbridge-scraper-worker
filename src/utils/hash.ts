import { createHash } from 'crypto';

export function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function getBufferSize(buffer: Buffer): number {
  return buffer.length;
}

export function computeFileHash(data: string | Buffer): { sha256: string; bytes: number } {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return {
    sha256: computeSha256(buffer),
    bytes: getBufferSize(buffer),
  };
}
