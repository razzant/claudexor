import type {
  ControlModelCatalogResponse,
  CredentialProfile,
  ModelCallRequest,
  ModelCallResult,
  ModelRoute,
  ModelInventoryAbsence,
} from "../schema/index.js";

/** Runtime-only context. Credentials stay inside the adapter, never a DTO. */
export interface ModelAdapterContext {
  profile: CredentialProfile;
  signal: AbortSignal;
  /** Operation-local discovery only. Revalidate against current adapter-owned
   * credentials before reuse; never a cross-operation/account catalog cache. */
  catalog?: ControlModelCatalogResponse;
  /** Keep exact failed-response evidence in the existing private result resource. */
  captureFailureEvidence?: boolean;
  /** Durably mark dispatch immediately before the single inference POST. */
  onDispatch: (route: ModelRoute) => Promise<void>;
}

/** One generation, not a harness session: no tools, retries, or conversation ownership. */
export interface ModelAdapter {
  readonly id: string;
  /** What a valid catalog miss proves; omitted keeps authoritative admission. */
  readonly inventoryAbsence?: ModelInventoryAbsence;
  catalog(context: Omit<ModelAdapterContext, "onDispatch">): Promise<ControlModelCatalogResponse>;
  invoke(request: ModelCallRequest, context: ModelAdapterContext): Promise<ModelCallResult>;
}
