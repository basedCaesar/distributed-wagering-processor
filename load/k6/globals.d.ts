/** O k6 tem `console`, mas o `@types/k6` não o declara (e a lib `DOM` traria globais que o k6 não tem). */
declare const console: { log(...args: unknown[]): void };
