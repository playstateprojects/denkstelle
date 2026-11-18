/** Device credentials and hashing. Pure (WebCrypto only) so both the SvelteKit server and scripts/devices.ts use it.
 * A credential looks like `dk_<64 hex>`. Only its SHA-256 is stored; revoking a device sets devices.revoked_at.
 */
const hex = (buf: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export const DEVICE_TOKEN_PREFIX = 'dk_';
export const newDeviceToken = () => DEVICE_TOKEN_PREFIX + hex(crypto.getRandomValues(new Uint8Array(32)));
export const looksLikeDeviceToken = (t: string) => /^dk_[0-9a-f]{64}$/.test(t);
export const sha256Hex = async (data: string | Uint8Array) =>
  hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>)));
