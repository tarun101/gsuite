interface Env {
  ACCESS_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  /**
   * Bearer token for POST /upload. Optional: when it is unset the endpoint is
   * not served at all, so a deployment that has not opted in exposes no upload
   * surface. Set it with: wrangler secret put GSUITE_UPLOAD_TOKEN
   */
  GSUITE_UPLOAD_TOKEN?: string;
}
