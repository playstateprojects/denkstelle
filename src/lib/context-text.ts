/** Pure helpers for project context documents: what we accept, and how extracted text is cut into passages.
 * No server or database dependencies, so it is unit-testable and safe to import anywhere. */

export const maxContextBytes=15*1024*1024;
/** Cap on extracted text per document (about 3x the length of Finnegans Wake). */
export const maxContextChars=3_000_000;
export const maxContextDocs=20;
const MIN_CHUNK=500;
const MAX_CHUNK=1500;

export type ContextFileKind={kind:'pdf'|'text';mime:string};
/** Which kind of context document an uploaded file is, or null if unsupported. Browsers often send no type for .txt/.md. */
export function contextFileKind(file:{type:string;name:string}):ContextFileKind|null{
  const type=file.type.split(';')[0].trim().toLowerCase();
  const ext=file.name.split('.').pop()?.toLowerCase()??'';
  if(type==='application/pdf'||(!type||type==='application/octet-stream')&&ext==='pdf')return {kind:'pdf',mime:'application/pdf'};
  if(type==='text/plain'||type==='text/markdown'||(!type||type==='application/octet-stream')&&(ext==='txt'||ext==='md'))return {kind:'text',mime:'text/plain'};
  return null;
}
/** A readable title for an uploaded file: the file name without its extension. */
export function titleFromFilename(name:string):string{
  return name.replace(/\.[a-z0-9]{1,5}$/i,'').replace(/[_]+/g,' ').trim().slice(0,160)||'Untitled';
}

export type ContextPage={page:number|null;text:string};
export type ContextChunk={sequence:number;page:number|null;charStart:number;charEnd:number;text:string};

export function normalizeText(s:string):string{
  return s.replace(/^﻿/,'').replace(/\r\n?/g,'\n').replace(/\u0000/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
/** Where to end a chunk that starts at `pos`: the last paragraph break, else sentence end, else whitespace, within the window. */
function breakPoint(norm:string,pos:number):number{
  const end=pos+MAX_CHUNK;
  if(end>=norm.length)return norm.length;
  const win=norm.slice(pos,end);
  const para=win.lastIndexOf('\n\n');
  if(para>=MIN_CHUNK)return pos+para;
  let sentence=-1;
  for(const m of win.matchAll(/[.!?…]['"”’)\]]*\s/g))if(m.index!>=MIN_CHUNK)sentence=m.index!+m[0].length;
  if(sentence>0)return pos+sentence;
  const space=Math.max(win.lastIndexOf(' '),win.lastIndexOf('\n'));
  if(space>=MIN_CHUNK)return pos+space;
  return end;
}
/** Cuts pages into passages of roughly 500-1500 characters. A passage never spans pages, so its page number is exact.
 * charStart/charEnd are offsets into the normalised text of that page, and `text` is exactly that slice. */
export function chunkPages(pages:ContextPage[]):ContextChunk[]{
  const out:ContextChunk[]=[];
  for(const p of pages){
    const norm=normalizeText(p.text);
    let pos=0;
    while(pos<norm.length){
      while(pos<norm.length&&/\s/.test(norm[pos]))pos++;
      if(pos>=norm.length)break;
      const end=breakPoint(norm,pos);
      let stop=end;
      while(stop>pos&&/\s/.test(norm[stop-1]))stop--;
      if(stop>pos)out.push({sequence:out.length,page:p.page,charStart:pos,charEnd:stop,text:norm.slice(pos,stop)});
      pos=Math.max(end,pos+1);
    }
  }
  return out;
}
