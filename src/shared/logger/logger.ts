import pino from "pino";
import { getContext } from "./request-context";

export const logger = pino({
  mixin() {
    return getContext() ?? {};
  },
});
