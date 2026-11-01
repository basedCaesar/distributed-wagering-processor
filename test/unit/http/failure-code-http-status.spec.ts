import { describe, expect, it } from "bun:test";
import {
  FAILURE_CODES,
  FailureCode,
} from "../../../src/modules/wagering/domain/failure-code";
import { FAILURE_CODE_HTTP_STATUS } from "../../../src/modules/wagering/infra/http/failure-code-http-status";

describe("S3 D5 D16.4: status HTTP de cada failureCode", () => {
  it("D5: todo FailureCode tem status", () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_CODE_HTTP_STATUS[code]).toBeNumber();
    }
  });

  it("D5 D16.4: códigos de rejeição → 422", () => {
    const rejections = FAILURE_CODES.filter(
      (code) => code !== FailureCode.ProcessingFailed,
    );
    for (const code of rejections) {
      expect(FAILURE_CODE_HTTP_STATUS[code]).toBe(422);
    }
  });

  it("D14.1 D16.4: PROCESSING_FAILED (FAILED, erro de infraestrutura) → 500", () => {
    expect(FAILURE_CODE_HTTP_STATUS[FailureCode.ProcessingFailed]).toBe(500);
  });
});
