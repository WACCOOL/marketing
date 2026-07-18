// The Workers-AI bge-m3 embedding helpers now live in @wac/shared/thom
// (embed.ts). This shim re-exports them so contentProject.ts keeps working
// unchanged. embedTexts/embedQuery accept the narrow ThomEnv, which apps/api's
// fat `Env` structurally satisfies.
export { embedQuery, embedTexts } from "@wac/shared/thom";
