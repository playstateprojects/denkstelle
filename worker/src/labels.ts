/** How statements are tagged in the theme and insight prompts. Interviews are I1, I2, ...; statements read from the
 * project's reference text (a source with role 'context') are T1, T2, ... so the model, and the code that counts, can
 * tell people from the text. */
export function sourceLabels(statements:{sourceId:string;fromText?:boolean}[]):Map<string,string>{
 const next={I:0,T:0};const out=new Map<string,string>();
 for(const s of statements){
  if(out.has(s.sourceId))continue;
  const k=s.fromText?'T':'I';
  out.set(s.sourceId,`${k}${++next[k]}`);
 }
 return out;
}
export const TEXT_NOTE="NOTE: statements tagged T1, T2, ... come from the project's reference texts, not from interviewees. They may belong to a theme or back an insight, but a text is not an interview: never count it as a person agreeing. When you refer to one, name it by its title from the REFERENCE TEXTS list (for example: in \"Title\", ...), never by its tag, and never as just \"the text\" when there is more than one.";

/** TEXT_NOTE plus which tag is which text, so themes and insights can say whose claim something is. Null without reference texts. */
export function textNote(statements:{sourceId:string;fromText?:boolean;sourceTitle?:string}[],label:Map<string,string>):string|null{
 const texts=new Map<string,string>();
 for(const s of statements)if(s.fromText&&!texts.has(s.sourceId))texts.set(s.sourceId,s.sourceTitle?.trim()||'Untitled text');
 if(!texts.size)return null;
 return `${TEXT_NOTE}\nREFERENCE TEXTS:\n${[...texts].map(([id,title])=>`${label.get(id)} = "${title}"`).join('\n')}`;
}
