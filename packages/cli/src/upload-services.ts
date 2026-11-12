import type { ResourceStorePort } from "@claudexor/daemon";

/** HTTP upload, keyed-import and managed-release services over the one daemon resource owner. */
export function uploadServices(resources: () => ResourceStorePort) {
  return {
    createUpload: async (input: unknown, idempotencyKey: string) =>
      resources().create(input, idempotencyKey),
    writeUpload: async (uploadId: string, chunks: AsyncIterable<Uint8Array>) =>
      resources().write(uploadId, chunks),
    uploadStatus: async (uploadId: string) => resources().status(uploadId),
    cancelUpload: async (uploadId: string) => resources().cancel(uploadId),
    finalizeUpload: async (
      uploadId: string,
      expectedSha256: string | undefined,
      idempotencyKey: string,
    ) => resources().finalize(uploadId, expectedSha256, idempotencyKey),
    importUpload: async (input: unknown, idempotencyKey: string) =>
      resources().importUpload(input, idempotencyKey),
    releaseResource: async (resourceId: string, input: unknown) =>
      resources().releaseResource(resourceId, input),
  };
}
