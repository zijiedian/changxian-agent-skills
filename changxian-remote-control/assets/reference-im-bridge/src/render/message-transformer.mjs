// ============================================================================
// MessageTransformer - AgentEvent 到 OutgoingMessage 的转换器
// 参考 OpenACP/src/core/message-transformer.ts
// ============================================================================

/**
 * @typedef {Object} FileInfo
 * @property {string} filePath
 * @property {string} content
 * @property {string} [oldContent]
 */

/**
 * @typedef {Object} SessionContext
 * @property {string} id
 * @property {string} workingDirectory
 */

/**
 * @typedef {Object} TunnelServiceInterface
 * @property {Object} getStore
 */

/**
 * 从工具名称和内容中提取文件信息
 */
function extractFileInfo(name, kind, content, rawInput, meta) {
  // 常见文件操作名称
  const fileOpNames = ['write', 'edit', 'read', 'create', 'update', 'delete', 'remove'];
  const lowerName = (name || '').toLowerCase();
  const lowerKind = (kind || '').toLowerCase();
  
  const isFileOp = fileOpNames.some((op) => lowerName.includes(op) || lowerKind.includes(op));
  if (!isFileOp) return null;

  // 尝试从 content 提取文件路径和内容
  if (content && typeof content === 'object') {
    const contentObj = content;
    
    // 查找文件路径
    const filePath =
      contentObj.path ||
      contentObj.filePath ||
      contentObj.file ||
      contentObj.target ||
      (meta && typeof meta === 'object' && meta.filePath);
    
    if (!filePath) return null;

    // 查找文件内容
    const fileContent =
      contentObj.content ||
      contentObj.text ||
      contentObj.newContent ||
      contentObj.new_text ||
      JSON.stringify(content, null, 2);

    // 查找旧内容（用于 diff）
    const oldContent = contentObj.oldContent || contentObj.old_text;

    if (!fileContent) return null;

    return {
      filePath,
      content: fileContent,
      oldContent,
    };
  }

  // 尝试从 rawInput 提取
  if (rawInput && typeof rawInput === 'object') {
    const inputObj = rawInput;
    const filePath =
      inputObj.path ||
      inputObj.filePath ||
      inputObj.file;
    
    if (filePath) {
      const content =
        inputObj.content ||
        inputObj.text ||
        JSON.stringify(rawInput);
      return { filePath, content };
    }
  }

  return null;
}

/**
 * MessageTransformer - 将 AgentEvent 转换为 OutgoingMessage
 */
export class MessageTransformer {
  constructor(tunnelService) {
    this.tunnelService = tunnelService;
  }

  /**
   * 设置 Tunnel 服务
   */
  setTunnelService(service) {
    this.tunnelService = service;
  }

  /**
   * 转换 AgentEvent 到 OutgoingMessage
   */
  transform(event, sessionContext) {
    switch (event.type) {
      case 'text':
        return { type: 'text', text: event.content };

      case 'thought':
        return { type: 'thought', text: event.content };

      case 'tool_call': {
        const meta = event.meta || {};
        const metadata = {
          id: event.id,
          name: event.name,
          kind: event.kind,
          status: event.status,
          content: event.content,
          locations: event.locations,
          rawInput: event.rawInput,
          displaySummary: meta.displaySummary,
          displayTitle: meta.displayTitle,
          displayKind: meta.displayKind,
        };
        this.enrichWithViewerLinks(event, metadata, sessionContext);
        return { type: 'tool_call', text: event.name, metadata };
      }

      case 'tool_update': {
        const meta = event.meta || {};
        const metadata = {
          id: event.id,
          name: event.name,
          kind: event.kind,
          status: event.status,
          content: event.content,
          rawInput: event.rawInput,
          displaySummary: meta.displaySummary,
          displayTitle: meta.displayTitle,
          displayKind: meta.displayKind,
        };
        this.enrichWithViewerLinks(event, metadata, sessionContext);
        return { type: 'tool_update', text: '', metadata };
      }

      case 'plan':
        return {
          type: 'plan',
          text: '',
          metadata: { entries: event.entries },
        };

      case 'usage':
        return {
          type: 'usage',
          text: '',
          metadata: {
            tokensUsed: event.tokensUsed,
            contextSize: event.contextSize,
            cost: event.cost?.amount,
          },
        };

      case 'session_end':
        return { type: 'session_end', text: `Done (${event.reason})` };

      case 'error':
        return { type: 'error', text: event.message };

      case 'system_message':
        return { type: 'system_message', text: event.message };

      case 'session_info_update':
        return {
          type: 'system_message',
          text: `Session updated: ${event.title ?? ''}`.trim(),
          metadata: { title: event.title, updatedAt: event.updatedAt },
        };

      case 'current_mode_update':
        return {
          type: 'mode_change',
          text: `Mode: ${event.modeId}`,
          metadata: { modeId: event.modeId },
        };

      case 'config_option_update':
        return {
          type: 'config_update',
          text: 'Config updated',
          metadata: { options: event.options },
        };

      case 'model_update':
        return {
          type: 'model_update',
          text: `Model: ${event.modelId}`,
          metadata: { modelId: event.modelId },
        };

      case 'user_message_chunk':
        return {
          type: 'user_replay',
          text: event.content,
        };

      case 'resource_content':
        return {
          type: 'resource',
          text: event.name,
          metadata: {
            uri: event.uri,
            text: event.text,
            blob: event.blob,
            mimeType: event.mimeType,
          },
        };

      case 'resource_link':
        return {
          type: 'resource_link',
          text: event.name,
          metadata: {
            uri: event.uri,
            mimeType: event.mimeType,
            title: event.title,
            description: event.description,
            size: event.size,
          },
        };

      case 'commands_update':
        return {
          type: 'system_message',
          text: `Commands updated: ${event.commands.map((c) => c.name).join(', ')}`,
          metadata: { commands: event.commands },
        };

      case 'image_content':
        return {
          type: 'attachment',
          text: '[Image]',
          attachment: {
            type: 'image',
            filePath: '',
            fileName: 'image',
            mimeType: event.mimeType,
            size: event.data.length,
          },
        };

      case 'audio_content':
        return {
          type: 'attachment',
          text: '[Audio]',
          attachment: {
            type: 'audio',
            filePath: '',
            fileName: 'audio',
            mimeType: event.mimeType,
            size: event.data.length,
          },
        };

      default:
        return { type: 'text', text: '' };
    }
  }

  /**
   * 批量转换事件数组
   */
  transformMany(events, sessionContext) {
    return events.map((event) => this.transform(event, sessionContext));
  }

  /**
   * 补充文件查看链接
   */
  enrichWithViewerLinks(event, metadata, sessionContext) {
    if (!this.tunnelService || !sessionContext) return;

    const name = event.name || '';
    const kind = event.kind;

    const fileInfo = extractFileInfo(
      name,
      kind,
      event.content,
      event.rawInput,
      event.meta,
    );

    if (!fileInfo) return;

    const store = this.tunnelService.getStore();
    const viewerLinks = {};

    // 对于有 diff 数据的编辑/写入操作
    if (fileInfo.oldContent) {
      const id = store.storeDiff(
        sessionContext.id,
        fileInfo.filePath,
        fileInfo.oldContent,
        fileInfo.content,
        sessionContext.workingDirectory,
      );
      if (id) viewerLinks.diff = this.tunnelService.diffUrl(id);
    }

    // 始终存储为文件视图（新建或读取）
    const id = store.storeFile(
      sessionContext.id,
      fileInfo.filePath,
      fileInfo.content,
      sessionContext.workingDirectory,
    );
    if (id) viewerLinks.file = this.tunnelService.fileUrl(id);

    if (Object.keys(viewerLinks).length > 0) {
      metadata.viewerLinks = viewerLinks;
      metadata.viewerFilePath = fileInfo.filePath;
    }
  }
}
