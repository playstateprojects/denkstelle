/** Render an approved highlight right now, bypassing the queue.
 * Usage: npm run render -- <highlight-uuid>
 * Approving a highlight in the dashboard normally queues this automatically; this is the manual route.
 * Publishing beyond the private project is NOT automated.
 */
import {database} from '../worker/src/utils.ts';
import {renderHighlight} from '../worker/src/render.ts';

const id=process.argv[2];if(!id||!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Usage: npm run render -- <highlight UUID>');
const sql=database();
try{await renderHighlight(sql,id);}finally{await sql.end();}
