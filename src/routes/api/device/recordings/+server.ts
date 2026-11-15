import type {RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {authenticateDevice,errorResponse,receiveRecording} from '$lib/server/device';
/** POST /api/device/recordings: one complete audio file as the raw body. See docs/DEVICE_API.md. */
export const POST:RequestHandler=async(event)=>{
  const sql=connect(event.platform);
  try{
    const ctx=await authenticateDevice(sql,event);
    return await receiveRecording(sql,ctx,event.request,event.platform);
  }catch(e){return errorResponse(e)}
  finally{await sql.end({timeout:1})}
};
