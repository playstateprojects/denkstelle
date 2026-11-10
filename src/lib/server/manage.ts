import {z} from 'zod';
import type postgres from 'postgres';
import {sha256,constantTimeEqual} from './receipt';
export const POLICY='draft-2026-11-05';
export const credentials=z.object({id:z.uuid(),code:z.string().length(64)});
export const clipPurposes=['public_excerpt','social_media'] as const;
export type ClipPurpose=(typeof clipPurposes)[number];
/** Returns the source if the recording ID + private code match, otherwise null. */
export async function authenticate(sql:postgres.Sql,id:string,code:string){
  const rows=await sql<{id:string;receipt_token_hash:string;media_key:string|null}[]>`select id,receipt_token_hash,media_key from sources where id=${id} limit 1`;
  const s=rows[0];
  return s&&constantTimeEqual(s.receipt_token_hash,await sha256(code))?s:null;
}
