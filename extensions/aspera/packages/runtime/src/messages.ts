import type {} from '@deepseek-ai/dsh-llm'
/** Messages from Aspera reuse DSH's durable user/message event. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    aspera: AsperaMessageSource
  }
}

/** Durable source identity for messages dispatched by Aspera. */
export interface AsperaMessageSource { kind: 'aspera'; experimentId: string }
