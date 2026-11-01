import type { Counter } from "prom-client";
import type { DuplicateLayer, SubmissionMetrics } from "../../application/ports";

/** `wagering_duplicates_total{layer}` (D11.2, D17.7). */
export class PromSubmissionMetrics implements SubmissionMetrics {
  constructor(private readonly duplicates: Counter<"layer">) {}

  countDuplicate(layer: DuplicateLayer): void {
    this.duplicates.inc({ layer });
  }
}
