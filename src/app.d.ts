declare module 'cloudflare:workers' { export const env: App.Platform['env']; }
declare global {
  namespace App {
    interface Locals {
      locale: 'de' | 'en';
      user: { id: string; email: string; name: string } | null;
      /** Set from the database (user.is_admin), and only computed for /admin routes. */
      isAdmin: boolean;
      session: { id: string; userId: string } | null;
    }
    interface Platform {
      env: {
        HYPERDRIVE?: { connectionString: string };
        MEDIA?: {
          put(key:string,value:ReadableStream|ArrayBuffer|string,options?:{httpMetadata?:{contentType?:string};customMetadata?:Record<string,string>}):Promise<unknown>;
          get(key:string,options?:{range?:{offset:number;length?:number}}):Promise<{body:ReadableStream;size:number}|null>;
          head(key:string):Promise<{size:number}|null>;
          delete(key:string):Promise<void>;
        };
        // Cloudflare Queue that wakes the processing worker (see processor/). Optional: absent in local dev.
        JOBS?: { send(message: { kind: 'upload' | 'approve' | 'reel' }): Promise<void> };
        AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
        DATABASE_URL?: string;
        BETTER_AUTH_SECRET?: string;
        BETTER_AUTH_URL?: string;
        ADMIN_EMAILS?: string;
        DEEPSEEK_API_KEY?: string;
        MISTRAL_API_KEY?: string;
        RESEND_API_KEY?: string;
        EMAIL_FROM?: string;
        PUBLIC_ORIGIN?: string;
      };
    }
  }
}
export {};
