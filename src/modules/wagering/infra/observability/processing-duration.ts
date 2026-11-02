import { type MetricChannel, wageringProcessingDurationSeconds } from "../../../../shared/metrics/metrics";

/**
 * Mede a chamada ao use case (D22.7): `wagering_processing_duration_seconds`
 * com o canal e o desfecho (`ok`/`error`). O erro segue para quem chamou.
 */
export async function measured<T>(channel: MetricChannel, work: () => Promise<T>): Promise<T> {
  const stop = wageringProcessingDurationSeconds.startTimer({ channel });
  try {
    const result = await work();
    stop({ outcome: "ok" });
    return result;
  } catch (error) {
    stop({ outcome: "error" });
    throw error;
  }
}
