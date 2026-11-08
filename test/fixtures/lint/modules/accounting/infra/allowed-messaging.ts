import { SqsConsumer } from "../../wagering/infra/messaging/sqs-consumer";
import { CONSUMER_POLICY } from "../../wagering/infra/messaging/consumer-policy";
import { SqsWagerQueue } from "../../wagering/infra/messaging/sqs-wager-queue";
import { trackDlqDepth } from "../../wagering/infra/observability/gauges";

export const allowed = [SqsConsumer, CONSUMER_POLICY, SqsWagerQueue, trackDlqDepth];
