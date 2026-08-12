import type { LLMProvider } from '@personal-agent/provider';
import type { ModelCallDebugEnd, ModelCallDebugStart } from '@personal-agent/core';
import {
  ProviderFeature,
  generateId,
  type ChatOptions,
  type UnifiedContentBlock,
  type UnifiedMessage,
  type UnifiedResponse,
} from '@personal-agent/shared';
import type { PromptImageInput } from './protocol';

const IMAGE_EXTRACTION_PROMPT = `你是图片信息提取器。请识别并完整描述用户上传图片中的内容：
1. 优先逐字提取所有可见文字，保留标题、段落、表格、代码、数字和错误信息的结构；
2. 补充说明与用户问题相关的界面控件、图表、对象、状态和空间关系；
3. 不要回答用户的问题，不要虚构不可见内容，只输出可供下游文本模型理解图片的客观信息。`;

export interface PreparedUserPrompt {
  /** 真正进入当前任务模型上下文的内容。 */
  modelContent: string | UnifiedContentBlock[];
  /** 界面和历史回放中展示的原始用户输入。 */
  displayContent?: UnifiedContentBlock[];
  usedVisionFallback: boolean;
}

export interface PrepareUserPromptOptions {
  text: string;
  displayText?: string;
  images: PromptImageInput[];
  currentProvider: LLMProvider;
  visionEnabled: boolean;
  getVisionProvider: () => Promise<LLMProvider>;
  onModelCallStart?: (call: ModelCallDebugStart) => void;
  onModelCallEnd?: (call: ModelCallDebugEnd) => void;
}

/**
 * 为当前任务模型准备图片输入：支持图片时原样直传，不支持时通过全局视觉模型转写。
 * getVisionProvider 使用惰性回调，确保原模型原生支持图片时不会额外调用或校验视觉模型。
 */
export async function prepareUserPromptInput(
  options: PrepareUserPromptOptions,
): Promise<PreparedUserPrompt> {
  const displayContent = buildContent(options.displayText ?? options.text, options.images);
  if (options.images.length === 0) {
    return { modelContent: options.text, usedVisionFallback: false };
  }

  if (options.currentProvider.supportsFeature(ProviderFeature.ImageInput)) {
    return {
      modelContent: buildContent(options.text, options.images),
      ...(options.displayText !== undefined && options.displayText !== options.text
        ? { displayContent }
        : {}),
      usedVisionFallback: false,
    };
  }

  if (!options.visionEnabled) {
    throw new Error(
      '当前模型不支持图片输入。请先在“设置 → 通用 → 视觉模型”中启用并配置视觉模型。',
    );
  }

  const visionProvider = await options.getVisionProvider();
  const messages: UnifiedMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `${IMAGE_EXTRACTION_PROMPT}\n\n用户文字请求：${options.text.trim() || '（未提供文字）'}`,
        },
        ...options.images.flatMap<UnifiedContentBlock>((image, index) => [
          { type: 'text', text: `图片 ${index + 1}：${image.name}` },
          toImageBlock(image),
        ]),
      ],
    },
  ];
  const chatOptions: ChatOptions = { maxTokens: 3000 };
  const callId = generateId();
  const startedAt = Date.now();
  options.onModelCallStart?.({
    callId,
    kind: 'vision',
    label: '图片视觉识别',
    turnNumber: 0,
    provider: visionProvider.providerId,
    model: visionProvider.getModel(),
    startedAt: new Date(startedAt).toISOString(),
    request: { messages: redactImageData(messages), tools: [], options: chatOptions },
  });

  let response: UnifiedResponse;
  try {
    response = await visionProvider.chat(messages, [], chatOptions);
    options.onModelCallEnd?.({
      callId,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status: 'completed',
      response: {
        messageId: response.id,
        model: response.model,
        text: extractResponseText(response),
        thinking: '',
        toolCalls: [],
        stopReason: response.stopReason,
        usage: response.usage,
      },
    });
  } catch (error) {
    options.onModelCallEnd?.({
      callId,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status: 'error',
      response: {
        model: visionProvider.getModel(),
        text: '',
        thinking: '',
        toolCalls: [],
        usage: null,
      },
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const extracted = extractResponseText(response);
  if (!extracted) throw new Error('视觉模型没有返回可用的图片识别结果，请检查模型配置后重试。');

  const prefix = options.text.trim()
    ? `${options.text.trim()}\n\n---\n以下是视觉模型从用户图片中提取的信息：`
    : '请根据以下由视觉模型从用户图片中提取的信息处理用户请求：';
  return {
    modelContent: `${prefix}\n${extracted}`,
    displayContent,
    usedVisionFallback: true,
  };
}

/** Debug 面板保留图片类型和名称，但不复制体积很大的 base64 数据。 */
function redactImageData(messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.map((message) => ({
    ...message,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) =>
            block.type === 'image'
              ? {
                  ...block,
                  source: {
                    ...block.source,
                    data: `[base64 已省略，${Math.round((block.source.data.length * 3) / 4)} bytes]`,
                  },
                }
              : block,
          ),
  }));
}

function buildContent(text: string, images: PromptImageInput[]): UnifiedContentBlock[] {
  return [
    ...(text.trim() ? ([{ type: 'text', text: text.trim() }] as UnifiedContentBlock[]) : []),
    ...images.map(toImageBlock),
  ];
}

function toImageBlock(image: PromptImageInput): UnifiedContentBlock {
  return {
    type: 'image',
    name: image.name,
    source: { data: image.data, mediaType: image.mediaType },
  };
}

function extractResponseText(response: UnifiedResponse): string {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
