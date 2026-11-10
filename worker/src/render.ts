/** render_highlight: render an approved candidate as a captioned, vertical MP4 with ffmpeg and store it privately in R2.
 * Publishing beyond the private project is NOT automated.
 */
import {join,extname} from 'node:path';
import {writeFile,copyFile,rm} from 'node:fs/promises';
import type {Sql} from 'postgres';
import {downloadObject,uploadObject,tempWorkspace,ffmpeg} from './utils.ts';
import {PermanentError,type Job} from './queue.ts';

function srtStamp(ms:number){const s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60),h=Math.floor(m/60);return `${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}

/** One captioned 9:16 part cut from a downloaded source file. Shared by highlights and theme reels.
 * Captions are the source's transcript segments overlapping the span; libass is told the real 1080x1920 canvas,
 * otherwise it scales font sizes from its 384x288 default and the text comes out several times too big. */
export async function renderPart(sql:Sql,o:{sourceId:string;src:string;mime:string|null;start_ms:number;end_ms:number;dir:string;name:string;part:string}):Promise<void>{
 const subs=join(o.dir,`${o.name}.srt`);
 const cues=await sql<{start_ms:number;end_ms:number;text:string}[]>`select start_ms,end_ms,text from source_segments
    where source_id=${o.sourceId} and start_ms<${o.end_ms} and end_ms>${o.start_ms} order by start_ms`;
 const len=o.end_ms-o.start_ms;
 const captions=cues.map((c,j)=>`${j+1}\n${srtStamp(Math.max(0,c.start_ms-o.start_ms))} --> ${srtStamp(Math.min(len,c.end_ms-o.start_ms))}\n${c.text.replace(/\n/g,' ')}\n`).join('\n');
 await writeFile(subs,captions);
 const style=`subtitles=${subs}:original_size=1080x1920:force_style='Fontsize=58,Alignment=2,MarginL=90,MarginR=90,MarginV=260,Outline=3,Shadow=0'`;
 const dur=String(len/1000);
 const encode=['-c:v','libx264','-preset','fast','-crf','22','-r','30','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-b:a','160k'];
 if(o.mime?.startsWith('audio/')){
   // Audio-only recording: captions over a plain black vertical frame, cut to the clip's audio.
   await ffmpeg('-f','lavfi','-i',`color=c=black:s=1080x1920:r=30:d=${dur}`,'-ss',String(o.start_ms/1000),'-i',o.src,'-t',dur,
     '-vf',style,'-map','0:v','-map','1:a',...encode,'-shortest',o.part);
 }else{
   const vf=`scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,${style}`;
   await ffmpeg('-ss',String(o.start_ms/1000),'-i',o.src,'-t',dur,'-vf',vf,...encode,o.part);
 }
}

/** Joins parts that share one encode (same codec, size, rate), so the streams can be copied. */
export async function concatParts(parts:string[],dir:string,out:string):Promise<void>{
 if(parts.length===1){await copyFile(parts[0],out);return;}
 const list=join(dir,'concat.txt');await writeFile(list,parts.map(f=>`file '${f}'`).join('\n'));
 await ffmpeg('-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',out);
}

export async function renderHighlight(sql:Sql,id:string):Promise<void>{
 const rows=await sql<{id:string;source_id:string;media_key:string;start_ms:number;end_ms:number;project_id:string;mime_type:string;clips:unknown}[]>`
  select h.id,h.source_id,s.media_key,h.start_ms,h.end_ms,s.project_id,s.mime_type,h.clips from highlights h join sources s on s.id=h.source_id where h.id=${id} and s.status='ready' and h.status='approved' limit 1`;
 if(!rows.length)throw new PermanentError('Highlight or source not ready (not approved, deleted, or source not analysed)');
 const h=rows[0];
 // For the pilot, do not create an exportable reel without publication consent.
 const permissions=await sql<{purpose:string;allowed:boolean}[]>`select purpose,allowed from source_permissions where source_id=${h.source_id} and purpose in ('public_excerpt','social_media')`;
 if(!permissions.some(p=>p.purpose==='public_excerpt'&&p.allowed))throw new PermanentError('No publication permission for this recording');
 let temp='';
 try{
   temp=await tempWorkspace();const src=join(temp,'original'+extname(h.media_key)),out=join(temp,'highlight.mp4');
   await downloadObject(h.media_key,src);
   const raw=Array.isArray(h.clips)?h.clips:[];
   const clips=raw.length?raw as {start_ms:number;end_ms:number}[]:[{start_ms:h.start_ms,end_ms:h.end_ms}];
   const rendered:string[]=[];
   for(let i=0;i<clips.length;i++){
     const clip=clips[i];if(clip.end_ms<=clip.start_ms)throw new PermanentError('Invalid clip span');
     const part=join(temp,`part-${i}.mp4`);
     await renderPart(sql,{sourceId:h.source_id,src,mime:h.mime_type,start_ms:clip.start_ms,end_ms:clip.end_ms,dir:temp,name:`captions-${i}`,part});
     rendered.push(part);
   }
   await concatParts(rendered,temp,out);
   const key=`projects/${h.project_id}/highlights/${h.id}.mp4`;await uploadObject(key,out,'video/mp4');
   await sql`update highlights set media_key=${key},status='rendered' where id=${id}`;
   console.log('Rendered privately:',id,key,'(social-media use requires editorial review and a separate social_media permission)');
 }finally{if(temp)await rm(temp,{recursive:true,force:true});}
}

/** Queue handler: the job row carries the highlight to render. */
export async function render(sql:Sql,job:Job):Promise<void>{
 if(!job.highlight_id)throw new PermanentError('render_highlight job has no highlight_id');
 await renderHighlight(sql,job.highlight_id);
}
