/**
 * 一次用户请求（responseSequence）内所有 LLM 调用（turn）合并展示的助手消息 id：
 * 一轮回复中的多次调用（思考/文本/工具）都归属同一条助手消息。
 */
export function assistantResponseId(responseSequence: number): string {
  return `assistant-response-${responseSequence}`;
}
