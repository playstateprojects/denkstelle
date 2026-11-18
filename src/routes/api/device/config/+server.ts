import {json,type RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {authenticateDevice,deviceConfig,errorResponse} from '$lib/server/device';
/** GET /api/device/config: what a handset needs to run one call (question, greeting audio, limits). */
export const GET:RequestHandler=async(event)=>{
  const sql=connect(event.platform);
  try{
    const ctx=await authenticateDevice(sql,event);
    return json(deviceConfig(ctx,event.url.origin),{headers:{'Cache-Control':'private, no-store'}});
  }catch(e){return errorResponse(e)}
  finally{await sql.end({timeout:1})}
};
