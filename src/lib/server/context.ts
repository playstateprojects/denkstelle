import type postgres from 'postgres';
import {extractText,getDocumentProxy} from 'unpdf';
import {chunkPages,maxContextChars,type ContextPage} from '$lib/context-text';

export class ContextError extends Error{constructor(public code:'unreadable'|'noText'|'tooLong'){super(code)}}

/** Text of each page of a PDF. Scanned PDFs without a text layer come back empty and are rejected by `saveContext`. */
export async function pdfPages(bytes:ArrayBuffer):Promise<ContextPage[]>{
  try{
    // pdf.js takes ownership of the buffer it is given and detaches it, so it gets a copy: the caller still stores `bytes`.
    const pdf=await getDocumentProxy(new Uint8Array(bytes.slice(0)));
    const {text}=await extractText(pdf,{mergePages:false});
    return text.map((t,i)=>({page:i+1,text:t}));
  }catch{throw new ContextError('unreadable')}
}
export function textPages(bytes:ArrayBuffer):ContextPage[]{
  return [{page:null,text:new TextDecoder('utf-8').decode(bytes)}];
}

type NewContext={projectId:string;title:string;kind:'pdf'|'text';mime:string|null;sizeBytes:number|null;mediaKey:string|null;pages:ContextPage[];extract:boolean};
/** Stores a context document as a source with role 'context', its text cut into source_segments, and queues the
 * ingest_context job (worker/src/context.ts) that embeds the passages and, with `extract`, reads them for statements.
 * The source stays 'uploaded' until that job has run. Context is never counted as a participant, whatever it produces. */
export async function saveContext(sql:postgres.Sql,c:NewContext):Promise<{id:string;chunks:number;chars:number;pages:number}>{
  const chunks=chunkPages(c.pages);
  const chars=chunks.reduce((n,k)=>n+k.text.length,0);
  if(!chunks.length)throw new ContextError('noText');
  if(chars>maxContextChars)throw new ContextError('tooLong');
  const pages=c.kind==='pdf'?c.pages.length:0;
  const id=await sql.begin(async tx=>{
    const [src]=await tx<{id:string}[]>`insert into sources(project_id,kind,role,title,status,media_key,mime_type,size_bytes,analysis)
      values(${c.projectId},${c.kind==='pdf'?'pdf':'text'},'context',${c.title},'uploaded',${c.mediaKey},${c.mime},${c.sizeBytes},${tx.json({chars,chunks:chunks.length,pages,extract:c.extract})})
      returning id`;
    // 6 parameters per row, so 500 rows per statement stays far below the 65,535 parameter limit.
    for(let i=0;i<chunks.length;i+=500){
      const rows=chunks.slice(i,i+500).map(k=>({source_id:src.id,sequence:k.sequence,page_number:k.page,char_start:k.charStart,char_end:k.charEnd,text:k.text}));
      await tx`insert into source_segments ${tx(rows,'source_id','sequence','page_number','char_start','char_end','text')}`;
    }
    await tx`insert into processing_jobs(source_id,kind,status) values(${src.id},'ingest_context','queued')`;
    return src.id;
  });
  return {id,chunks:chunks.length,chars,pages};
}
