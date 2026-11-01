import { PublishCommand } from "@aws-sdk/client-sns";
import type { ClaimedEvent, EventPublisher } from "./outbox-publisher";

/** O pedaço do `SNSClient` que o publisher usa; os testes o decoram (D20.6). */
export interface SnsSender {
  send(command: PublishCommand): Promise<unknown>;
}

/**
 * Publica no tópico SNS FIFO (D9.1): o corpo é o envelope do §11 como está
 * no `jsonb` (D20.9); `MessageGroupId` = `walletId`, para a ordem por
 * wallet; `MessageDeduplicationId` = `eventId`, só otimização.
 */
export class SnsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SnsSender,
    private readonly topicArn: string,
  ) {}

  async publish(event: ClaimedEvent): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(event.payload),
        MessageGroupId: event.orderingKey,
        MessageDeduplicationId: event.id,
      }),
    );
  }
}
