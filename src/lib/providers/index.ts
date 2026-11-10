// سجل المحوّلات: مزود واحد لكل معرّف — يختارها المنسّق حسب مفتاح المزود المستخدم
import type { ProviderId } from "../types";
import { kieAdapter } from "./kie";
import { cometAdapter } from "./cometapi";
import type { ProviderAdapter } from "./types";

export type { ProviderAdapter, ProviderKey } from "./types";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometAdapter,
};
