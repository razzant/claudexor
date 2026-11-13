/** Maximum age of a positive physical doctor/login probe. Reuse never renews it. */
export const DOCTOR_TTL_MS = Number(process.env.CLAUDEXOR_DOCTOR_TTL_MS ?? 90_000);
