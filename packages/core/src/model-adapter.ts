import type {
  ControlModelCatalogResponse,
  CredentialProfile,
  ImageCallRequest,
  ImageCallResult,
  ImageGenerationCapability,
  ModelCallRequest,
  ModelCallResult,
  ModelRoute,
  QuotaSnapshot,
  ModelInventoryAbsence,
} from "@claudexor/schema";

/** Runtime-only context. Credentials stay inside the adapter, never a DTO. */
export interface ModelAdapterContext {
  profile: CredentialProfile;
  signal: AbortSignal;
  /** Known credential epoch supplied by the engine; absent/NaN never joins raw I/O. */
  credentialGeneration?: number;
  /** Only raw-model selection may use a completed catalog observation. */
  reuseCatalog?: boolean;
  /** Operation-local discovery only. Revalidate against current adapter-owned
   * credentials before reuse; never a cross-operation/account catalog cache. */
  catalog?: ControlModelCatalogResponse;
  /** Keep exact failed-response evidence in the existing private result resource. */
  captureFailureEvidence?: boolean;
  /** Preserve provider content refusals in the caller's error and assistant message. */
  typedRefusals?: boolean;
  /** Account evidence must ignore a provider content refusal even for legacy callers. */
  onContentRefusal?: () => void;
  /** Durably mark dispatch immediately before the single inference POST. */
  onDispatch: (route: ModelRoute) => Promise<void>;
}

/** Image generation/edit is the same one-generation discipline over a
 * different wire: no text catalog read, no text quota, no retry. The facet is
 * absent on sources that have no image operations; absence is structural. */
export interface ModelImageFacet {
  readonly capability: ImageGenerationCapability;
  invoke(
    request: ImageCallRequest,
    context: Omit<ModelAdapterContext, "catalog" | "typedRefusals" | "onContentRefusal"> & {
      imageTurnId: string;
      onQuota?: (snapshot: QuotaSnapshot) => void;
    },
  ): Promise<ImageCallResult>;
}

/** One generation, not a harness session: no tools, retries, or conversation ownership. */
export interface ModelAdapter {
  readonly id: string;
  close?(): void;
  /** What a valid catalog miss proves; omitted keeps authoritative admission. */
  readonly inventoryAbsence?: ModelInventoryAbsence;
  catalog(
    context: Omit<ModelAdapterContext, "onDispatch" | "typedRefusals" | "onContentRefusal">,
  ): Promise<ControlModelCatalogResponse>;
  invoke(request: ModelCallRequest, context: ModelAdapterContext): Promise<ModelCallResult>;
  readonly image?: ModelImageFacet;
}
