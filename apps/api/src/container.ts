import { Container } from "@cloudflare/containers";
import type { Env } from "./env.js";

/**
 * Container-enabled Durable Object for the generation Container (Phase 2b).
 *
 * The queue consumer routes a job to an instance (keyed by jobId) and POSTs the
 * payload to the container's HTTP handler. Secrets are injected via `envVars` so
 * the container can write to R2 (S3 API) and Supabase without baking creds into
 * the image.
 *
 * NOTE: `envVars` is set in the constructor, NOT via a `get envVars()` accessor.
 * The base `Container` class declares `envVars` as an initialized field, and
 * this Worker targets ES2022 (useDefineForClassFields) with noImplicitOverride,
 * so an accessor override would fail to compile and/or be clobbered to {} by the
 * base field initializer. A constructor assignment after super() is writable.
 */
export class GenerationContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";

  // Inherit the base constructor's exact parameter types (the ctx type comes
  // from cloudflare:workers, which differs from the ambient global) so the
  // super() call typechecks without naming DurableObjectState directly.
  constructor(...args: ConstructorParameters<typeof Container<Env>>) {
    super(...args);
    const env = args[1];
    this.envVars = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      R2_ENDPOINT: env.R2_ENDPOINT,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
      // Phase 2d AI providers — only set when configured (composite mode needs
      // neither). The container reads these in loadConfig().
      ...(env.BFL_API_KEY ? { BFL_API_KEY: env.BFL_API_KEY } : {}),
      ...(env.GEMINI_API_KEY ? { GEMINI_API_KEY: env.GEMINI_API_KEY } : {}),
      ...(env.GEMINI_SCENE_MODEL
        ? { GEMINI_SCENE_MODEL: env.GEMINI_SCENE_MODEL }
        : {}),
      ...(env.FAL_API_KEY ? { FAL_API_KEY: env.FAL_API_KEY } : {}),
    };
  }
}
