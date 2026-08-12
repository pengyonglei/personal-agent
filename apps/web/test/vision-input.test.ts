import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LLMProvider } from '@personal-agent/provider';
import {
  ProviderFeature,
  type ModelInfo,
  type UnifiedMessage,
  type UnifiedResponse,
} from '@personal-agent/shared';
import { prepareUserPromptInput } from '../src/vision-input';

const image = {
  name: 'error.png',
  mediaType: 'image/png' as const,
  data: Buffer.from('image').toString('base64'),
};

class StubProvider implements LLMProvider {
  readonly providerId = 'stub';
  readonly displayName = 'Stub';
  calls: UnifiedMessage[][] = [];
  constructor(
    private readonly imageInput: boolean,
    private readonly responseText = '错误代码：E1001',
  ) {}
  async *streamChat(): AsyncIterable<never> {}
  async chat(messages: UnifiedMessage[]): Promise<UnifiedResponse> {
    this.calls.push(messages);
    return {
      id: 'response-1',
      model: 'stub-model',
      content: [{ type: 'text', text: this.responseText }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  supportsFeature(feature: ProviderFeature): boolean {
    return feature === ProviderFeature.ImageInput && this.imageInput;
  }
  getModelList(): ModelInfo[] {
    return [];
  }
  countTokens(): number {
    return 0;
  }
  setModel(): void {}
  getModel(): string {
    return 'stub-model';
  }
  async initialize(): Promise<void> {}
  async dispose(): Promise<void> {}
}

test('image-capable current model receives original text and image without vision fallback', async () => {
  const current = new StubProvider(true);
  let resolvedVision = false;
  const prepared = await prepareUserPromptInput({
    text: '解释这个错误',
    images: [image],
    currentProvider: current,
    visionEnabled: false,
    getVisionProvider: async () => {
      resolvedVision = true;
      return new StubProvider(true);
    },
  });
  assert.equal(resolvedVision, false);
  assert.equal(prepared.usedVisionFallback, false);
  assert.equal(Array.isArray(prepared.modelContent), true);
  assert.equal((prepared.modelContent as Array<{ type: string }>)[1]?.type, 'image');
  assert.equal(prepared.displayContent, undefined);
});

test('text-only current model receives text merged with global vision extraction', async () => {
  const vision = new StubProvider(true, '截图文字：Dynamic require of tty is not supported');
  const debugStarts: Array<{ kind?: string; label?: string; request: UnifiedMessage[] }> = [];
  const debugEnds: Array<{ status: string; text: string }> = [];
  const prepared = await prepareUserPromptInput({
    text: '帮我修复',
    displayText: '帮我修复',
    images: [image],
    currentProvider: new StubProvider(false),
    visionEnabled: true,
    getVisionProvider: async () => vision,
    onModelCallStart: (call) =>
      debugStarts.push({ kind: call.kind, label: call.label, request: call.request.messages }),
    onModelCallEnd: (call) =>
      debugEnds.push({ status: call.status, text: call.response.text }),
  });
  assert.equal(prepared.usedVisionFallback, true);
  assert.match(String(prepared.modelContent), /帮我修复/);
  assert.match(String(prepared.modelContent), /Dynamic require of tty/);
  assert.equal(prepared.displayContent?.[0]?.type, 'text');
  assert.equal(prepared.displayContent?.[1]?.type, 'image');
  assert.equal(vision.calls.length, 1);
  assert.equal(debugStarts[0]?.kind, 'vision');
  assert.equal(debugStarts[0]?.label, '图片视觉识别');
  assert.match(JSON.stringify(debugStarts[0]?.request), /base64 已省略/);
  assert.doesNotMatch(JSON.stringify(debugStarts[0]?.request), new RegExp(image.data));
  assert.deepEqual(debugEnds, [
    { status: 'completed', text: '截图文字：Dynamic require of tty is not supported' },
  ]);
});

test('text-only current model rejects images when global vision model is disabled', async () => {
  await assert.rejects(
    () =>
      prepareUserPromptInput({
        text: '',
        images: [image],
        currentProvider: new StubProvider(false),
        visionEnabled: false,
        getVisionProvider: async () => new StubProvider(true),
      }),
    /设置 → 通用 → 视觉模型/,
  );
});
