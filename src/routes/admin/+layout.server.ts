import { requireDbAdmin } from '$lib/server/access';
import type { LayoutServerLoad } from './$types';
// hooks.server.ts already gates /admin; this keeps the page's own data from ever loading without the flag.
export const load: LayoutServerLoad = ({ locals }) => { requireDbAdmin(locals); return {}; };
