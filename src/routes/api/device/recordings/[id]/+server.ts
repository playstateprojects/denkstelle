import type {RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {authenticateDevice,errorResponse,recordingStatus} from '$lib/server/device';
/** GET /api/device/recordings/:recordingId: has the server received this recording? (200 yes, 404 upload again) */
export const GET:RequestHandler=async(event)=>{
  const sql=connect(event.platform);
  try{
    const ctx=await authenticateDevice(sql,event);
    return await recordingStatus(sql,ctx,event.params.id??'');
  }catch(e){return errorResponse(e)}
  finally{await sql.end({timeout:1})}
};
