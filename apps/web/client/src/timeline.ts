export function assistantTurnId(responseSequence: number, turnNumber: number): string {
  return `assistant-response-${responseSequence}-turn-${turnNumber}`;
}
