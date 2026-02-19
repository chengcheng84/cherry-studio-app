import {
  assistantDatabase,
  mcpDatabase,
  messageBlockDatabase,
  messageDatabase,
  providerDatabase,
  topicDatabase,
  websearchProviderDatabase
} from '@database'
import type { Dispatch } from '@reduxjs/toolkit'
import { parser as createParser } from 'clarinet'
import dayjs from 'dayjs'
import { Directory, File, Paths } from 'expo-file-system'
import * as FileSystem from 'expo-file-system/legacy'
import { unzip, zip } from 'react-native-zip-archive'

import { getSystemAssistants } from '@/config/assistants'
import { DEFAULT_BACKUP_STORAGE, DEFAULT_DOCUMENTS_STORAGE } from '@/constants/storage'
import { loggerService } from '@/services/LoggerService'
import { preferenceService } from '@/services/PreferenceService'
import type { Assistant, Topic } from '@/types/assistant'
import type {
  ExportIndexedData,
  ExportReduxData,
  ImportIndexedData,
  ImportReduxData,
  Setting
} from '@/types/databackup'
import type { FileMetadata } from '@/types/file'
import type { Message } from '@/types/message'

import { resetAppInitializationState, runAppDataMigrations } from './AppInitializationService'
import { assistantService } from './AssistantService'
import { providerService } from './ProviderService'
import { topicService } from './TopicService'

// 流式读取阈值: 5MB
const STREAM_THRESHOLD = 5 * 1024 * 1024
// 旧解析器最大支持文件大小: 200MB
const LEGACY_MAX_SIZE = 200 * 1024 * 1024
const logger = loggerService.withContext('Backup Service')

export type RestoreStepId = 'clear_data' | 'receive_file' | 'restore_settings' | 'restore_messages'

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'error'

export type ProgressUpdate = {
  step: RestoreStepId
  status: StepStatus
  error?: string
}

type OnProgressCallback = (update: ProgressUpdate) => void

/**
 * 流式 JSON 解析器：避免大文件导致的内存溢出
 * 使用 clarinet SAX 解析器逐步解析 JSON，而不是一次性加载到内存
 */
async function parseBackupDataStreaming(
  file: File,
  onProgress: (stage: string, details?: string) => void
): Promise<{
  reduxData: ExportReduxData
  indexedData: ExportIndexedData
  appInitializationVersion?: number
}> {
  // 初始化数据存储
  let appInitializationVersion: number | undefined
  let localStorageData: any = {}
  let reduxData: ExportReduxData | undefined
  
  // 流式处理数组
  const topics: Topic[] = []
  const messages: Message[] = []
  const messageBlocks: any[] = []
  const settings: any[] = []
  
  // 处理状态
  let parsingTarget = ''
  let currentArray: any[] | null = null
  let arrayItemCount = 0
  
  // 处理大value的阈值
  const LARGE_VALUE_THRESHOLD = 10 * 1024 * 1024 // 10MB
  
  const parser = createParser()
  let depth = 0
  let currentKey = ''
  const stack: any[] = []
  
  // 处理大文件的缓冲
  let buffer = ''
  let bufferSize = 0
  const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB buffer for parsing
  
  // 使用一个 Promise 来处理解析完成事件
  return new Promise((resolve, reject) => {
    parser.onerror = (error: Error) => {
      logger.error('JSON streaming parse error:', error)
      reject(error)
    }
    
    parser.onopenobject = (key: string) => {
      depth++
      const newObj: any = {}
      
      if (depth === 1) {
        if (key === 'localStorage') {
          parsingTarget = 'localStorage'
        } else if (key === 'indexedDB') {
          parsingTarget = 'indexedDB'
        } else {
          parsingTarget = 'backup'
        }
      } else if (depth === 2 && parsingTarget === 'indexedDB') {
        if (key === 'topics') {
          currentArray = topics
          parsingTarget = 'topics'
          onProgress('parsing-topics', 'Starting...')
        } else if (key === 'messages') {
          currentArray = messages
          parsingTarget = 'messages'
          onProgress('parsing-messages', 'Starting...')
        } else if (key === 'message_blocks') {
          currentArray = messageBlocks
          parsingTarget = 'message_blocks'
          onProgress('parsing-message-blocks', 'Starting...')
        } else if (key === 'settings') {
          currentArray = settings
          parsingTarget = 'settings'
        }
      } else if (depth === 3 && currentArray) {
        // 数组元素对象，不需要特殊处理，stack 机制会处理
      }
      
      if (stack.length > 0) {
        const parent = stack[stack.length - 1]
        if (Array.isArray(parent)) {
          parent.push(newObj)
        } else {
          parent[currentKey] = newObj
        }
      }
      
      stack.push(newObj)
      currentKey = key
    }
    
    parser.oncloseobject = () => {
      depth--
      stack.pop()
      
      if (depth === 0) {
        // 解析完成
        onProgress('completed', 'JSON parsing finished')
        
        try {
          // 解析 Redux 数据
          const persistDataString = localStorageData['persist:cherry-studio']
          if (persistDataString === undefined) {
            const availableKeys = Object.keys(localStorageData)
            throw new Error(`Missing 'persist:cherry-studio' in localStorage. Available keys: ${availableKeys.join(', ')}`)
          }
          const rawReduxData = JSON.parse(persistDataString)
          
          reduxData = {
            assistants: JSON.parse(rawReduxData.assistants),
            llm: JSON.parse(rawReduxData.llm),
            websearch: JSON.parse(rawReduxData.websearch),
            settings: JSON.parse(rawReduxData.settings),
            mcp: rawReduxData.mcp ? JSON.parse(rawReduxData.mcp) : undefined
          }
          
          // 构建最终结果
          const indexedData: ExportIndexedData = {
            topics,
            messages,
            message_blocks: messageBlocks,
            settings
          }
          
          logger.info('Streaming parse completed successfully')
          logger.info(`Extracted ${messages.length} messages from ${topics.length} topics`)
          
          resolve({
            reduxData: reduxData!,
            indexedData,
            appInitializationVersion
          })
        } catch (error) {
          logger.error('Error in final processing:', error)
          reject(error)
        }
      }
    }
    
    parser.onopenarray = () => {
      depth++
      arrayItemCount = 0
    }
    
    parser.onclosearray = () => {
      depth--
      if (currentArray) {
        onProgress(`parsed-${parsingTarget}`, `Total: ${arrayItemCount} items`)
        currentArray = null
      }
    }
    
    parser.onkey = (key: string) => {
      currentKey = key
      // 在根对象层级（depth=1）更新 parsingTarget
      if (depth === 1) {
        if (key === 'localStorage') {
          parsingTarget = 'localStorage'
        } else if (key === 'indexedDB') {
          parsingTarget = 'indexedDB'
        }
      }
    }
    
    parser.onvalue = (value: any) => {
      // 检查是否是大value
      if (typeof value === 'string' && value.length > LARGE_VALUE_THRESHOLD) {
        logger.warn(`Large value for key: ${currentKey}, size: ${(value.length / 1024 / 1024).toFixed(2)}MB`)
        value = `[LARGE_VALUE_SKIPPED: ${value.length} bytes]`
      }
      
      if (parsingTarget === 'localStorage' && depth === 2) {
        localStorageData[currentKey] = value
      } else if (parsingTarget === 'indexedDB' && depth === 2) {
        if (currentKey === 'app_initialization_version') {
          appInitializationVersion = value
        }
      } else if (currentArray && depth >= 3) {
        currentArray.push(value)
        arrayItemCount++
        
        if (arrayItemCount % 1000 === 0) {
          onProgress(`parsing-${parsingTarget}`, `Progress: ${arrayItemCount} items`)
        }
      }
    }
    
    // 开始读取文件
    // cast to any to avoid type mismatch between different onProgress signatures
    ;(onProgress as any)('reading', `Starting to read ${(file.size / 1024 / 1024).toFixed(2)}MB file...`)
    
    // 使用异步 IIFE 来处理文件读取
    ;(async () => {
      try {
        if (file.size <= STREAM_THRESHOLD) {
          const content = await file.text()
          onProgress('parsing', 'Parsing JSON...')
          parser.write(content)
          parser.close()
        } else {
          const chunkSize = 512 * 1024 // 512KB
          let position = 0
          let totalRead = 0
          
          while (position < file.size) {
            const remaining = file.size - position
            const currentChunkSize = Math.min(chunkSize, remaining)
            
            const chunk = await FileSystem.readAsStringAsync(file.uri, {
              encoding: FileSystem.EncodingType.UTF8,
              position,
              length: currentChunkSize
            })
            
            buffer += chunk
            bufferSize += chunk.length
            
            if (bufferSize >= MAX_BUFFER_SIZE || position + currentChunkSize >= file.size) {
              parser.write(buffer)
              buffer = ''
              bufferSize = 0
            }
            
            totalRead += currentChunkSize
            position += currentChunkSize
            
            if (totalRead % (10 * 1024 * 1024) === 0 || position >= file.size) {
              onProgress('reading-parsing', `Processed ${(totalRead / 1024 / 1024).toFixed(2)}MB / ${(file.size / 1024 / 1024).toFixed(2)}MB`)
            }
          }
          
          parser.close()
        }
      } catch (error) {
        reject(error)
      }
    })()
  })
}

async function parseWithLegacyParser(file: File, _onProgress: OnProgressCallback): Promise<{
  reduxData: ExportReduxData
  indexedData: ExportIndexedData
  appInitializationVersion?: number
}> {
  // 如果文件过大，旧解析器会内存溢出，直接抛出错误
  if (file.size > LEGACY_MAX_SIZE) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(2)}MB) for legacy parser. Maximum size is ${(LEGACY_MAX_SIZE / 1024 / 1024).toFixed(2)}MB.`)
  }
  const fileContent = await file.text()
  return transformBackupData(fileContent)
}

async function restoreIndexedDbData(data: ExportIndexedData, onProgress: OnProgressCallback, _dispatch: Dispatch) {
  onProgress({ step: 'restore_messages', status: 'in_progress' })

  // 根据数据量动态调整批次大小
  const topicCount = data.topics.length
  const messageCount = data.messages.length
  const blockCount = data.message_blocks.length

  // 数据量越大，批次越小，避免单次操作占用太多内存
  const BATCH_SIZE = messageCount > 10000 ? 20 : messageCount > 1000 ? 50 : 100

  logger.info(`Processing ${topicCount} topics, ${messageCount} messages, ${blockCount} blocks`)
  logger.info(`Using batch size: ${BATCH_SIZE}`)

  // 获取数据库中现有的 assistant IDs，用于验证 topics
  const existingAssistants = await assistantDatabase.getAllAssistants()
  const existingAssistantIds = new Set(existingAssistants.map(a => a.id))
  logger.info(`Validating topics against ${existingAssistantIds.size} existing assistants`)

  // 检查并修复 topics 中的无效 assistantId
  const topicAssistantIds = new Set(data.topics.map(t => t.assistantId))
  const missingTopicAssistantIds = [...topicAssistantIds].filter(id => !existingAssistantIds.has(id))

  if (missingTopicAssistantIds.length > 0) {
    const affectedTopicsCount = data.topics.filter(t => missingTopicAssistantIds.includes(t.assistantId)).length
    logger.warn(
      `Fixed ${affectedTopicsCount} topics with missing assistant_id by replacing with "default". Missing IDs: ${missingTopicAssistantIds.join(', ')}`
    )

    data.topics = data.topics.map(topic => {
      if (missingTopicAssistantIds.includes(topic.assistantId)) {
        return {
          ...topic,
          assistantId: 'default'
        }
      }
      return topic
    })
  }

  // 分批处理 topics
  for (let i = 0; i < topicCount; i += BATCH_SIZE) {
    const batch = data.topics.slice(i, Math.min(i + BATCH_SIZE, topicCount))
    await topicDatabase.upsertTopics(batch)

    if (i % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= topicCount) {
      logger.info(`Topics: ${Math.min(i + BATCH_SIZE, topicCount)}/${topicCount}`)
    }
  }

  // 验证并修复 messages 中的外键引用
  const messageAssistantIds = new Set(data.messages.map(msg => msg.assistantId))
  const messageTopicIds = new Set(data.messages.map(msg => msg.topicId))
  const validTopicIds = new Set(data.topics.map(t => t.id))

  // 检查是否有 messages 引用了不存在的 assistantId
  const missingAssistantIds = [...messageAssistantIds].filter(id => !existingAssistantIds.has(id))
  if (missingAssistantIds.length > 0) {
    const affectedMessagesCount = data.messages.filter(msg => missingAssistantIds.includes(msg.assistantId)).length
    logger.warn(
      `Fixed ${affectedMessagesCount} messages with missing assistant_id by replacing with "default". Missing IDs: ${missingAssistantIds.join(', ')}`
    )

    data.messages = data.messages.map(msg => {
      if (missingAssistantIds.includes(msg.assistantId)) {
        return {
          ...msg,
          assistantId: 'default'
        }
      }
      return msg
    })
  }

  // 检查是否有 messages 引用了不存在的 topicId
  const missingTopicIds = [...messageTopicIds].filter(id => !validTopicIds.has(id))
  if (missingTopicIds.length > 0) {
    const originalCount = data.messages.length
    data.messages = data.messages.filter(msg => !missingTopicIds.includes(msg.topicId))
    const filteredCount = originalCount - data.messages.length

    if (filteredCount > 0) {
      logger.error(
        `Filtered out ${filteredCount} messages with invalid topic_id references. Missing topic IDs: ${missingTopicIds.join(', ')}`
      )
    }
  }

  // 分批处理 messages
  const finalMessageCount = data.messages.length
  for (let i = 0; i < finalMessageCount; i += BATCH_SIZE) {
    const batch = data.messages.slice(i, Math.min(i + BATCH_SIZE, finalMessageCount))
    await messageDatabase.upsertMessages(batch)

    if (i % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= finalMessageCount) {
      logger.info(`Messages: ${Math.min(i + BATCH_SIZE, finalMessageCount)}/${finalMessageCount}`)
    }
  }

  // 分批过滤和处理 message_blocks
  logger.info('Processing message blocks...')
  const validMessageIds = new Set(data.messages.map(msg => msg.id))
  let filteredCount = 0
  let processedBlocks = 0

  for (let i = 0; i < blockCount; i += BATCH_SIZE) {
    const batch = data.message_blocks.slice(i, Math.min(i + BATCH_SIZE, blockCount))
    const validBlocks = batch.filter(block => {
      const isValid = validMessageIds.has(block.messageId)
      if (!isValid) filteredCount++
      return isValid
    })

    if (validBlocks.length > 0) {
      await messageBlockDatabase.upsertBlocks(validBlocks)
      processedBlocks += validBlocks.length
    }

    if (i % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= blockCount) {
      logger.info(`Blocks: ${Math.min(i + BATCH_SIZE, blockCount)}/${blockCount} (valid: ${processedBlocks})`)
    }
  }

  if (filteredCount > 0) {
    logger.warn(`Filtered out ${filteredCount} message block(s) with invalid message_id references`)
  }

  // 清理 Set 对象
  validMessageIds.clear()

  // Invalidate caches after bulk import to ensure consistency
  topicService.invalidateCache()
  assistantService.invalidateCache()

  if (data.settings) {
    const avatarSetting = data.settings.find(setting => setting.id === 'image://avatar')

    if (avatarSetting) {
      await preferenceService.set('user.avatar', avatarSetting.value)
    }
  }

  logger.info('IndexedDB data restore completed')
  onProgress({ step: 'restore_messages', status: 'completed' })
}

async function restoreReduxData(data: ExportReduxData, onProgress: OnProgressCallback, _dispatch: Dispatch) {
  onProgress({ step: 'restore_settings', status: 'in_progress' })
  await providerDatabase.upsertProviders(data.llm.providers)
  providerService.invalidateCache()
  await providerService.refreshAllProvidersCache()
  const allSourceAssistants = [data.assistants.defaultAssistant, ...data.assistants.assistants]

  // default assistant为built_in, 其余为external
  const assistants = allSourceAssistants.map(
    (assistant, index) =>
      ({
        ...assistant,
        type: index === 0 ? 'system' : 'external'
      }) as Assistant
  )

  logger.info(`Restoring ${assistants.length} assistants`)
  await assistantDatabase.upsertAssistants(assistants)

  await websearchProviderDatabase.upsertWebSearchProviders(data.websearch.providers)

  // 恢复 MCP 数据（如果存在，兼容旧备份）
  if (data.mcp?.servers && data.mcp.servers.length > 0) {
    logger.info(`Restoring ${data.mcp.servers.length} MCP servers`)
    await mcpDatabase.upsertMcps(data.mcp.servers)
  }

  await new Promise(resolve => setTimeout(resolve, 200)) // Delay between steps

  await preferenceService.set('user.name', data.settings.userName)
  onProgress({ step: 'restore_settings', status: 'completed' })
}

export async function restore(
  backupFile: Omit<FileMetadata, 'md5'>,
  onProgress: OnProgressCallback,
  dispatch: Dispatch
) {
  if (!DEFAULT_DOCUMENTS_STORAGE.exists) {
    DEFAULT_DOCUMENTS_STORAGE.create({ intermediates: true, overwrite: true })
  }

  let unzipPath: string | undefined

  try {
    const extractedDirPath = Paths.join(DEFAULT_DOCUMENTS_STORAGE, backupFile.name.replace('.zip', ''))
    logger.info('Unzipping backup file...')
    await unzip(backupFile.path, extractedDirPath)
    unzipPath = extractedDirPath

    const dataFile = new File(extractedDirPath, 'data.json')

    // TODO: 长期方案 - 重构备份格式为分文件存储，避免读取大 JSON 文件
    // 当前依赖流式JSON 来处理大文件（>100MB）
    logger.info('Starting to read backup file, size:', dataFile.size, 'bytes')
    logger.info(`File size ${(dataFile.size / 1024 / 1024).toFixed(2)}MB, using streaming parser`)
    
    let parsedData: { reduxData: ExportReduxData; indexedData: ExportIndexedData; appInitializationVersion?: number }
    
    try {
      parsedData = await parseBackupDataStreaming(dataFile, (stage, details) => {
        logger.info(`Streaming parse: ${stage}${details ? ` - ${details}` : ''}`)
      })
      
      logger.info('Streaming parse completed successfully')
    } catch (parseError) {
      logger.error('Streaming parse failed, falling back to legacy parser:', parseError)
      
      // 回退到旧解析器（用于兼容）
      onProgress({ step: 'restore_messages', status: 'in_progress', error: 'Using legacy parser due to streaming parse error' })
      parsedData = await parseWithLegacyParser(dataFile, onProgress)
    }

    logger.info('Restoring Redux data...')
    await restoreReduxData(parsedData.reduxData, onProgress, dispatch)

    // Redux 数据已写入，释放内存
    // @ts-ignore
    parsedData.reduxData = null

    logger.info('Restoring IndexedDB data...')
    await restoreIndexedDbData(parsedData.indexedData, onProgress, dispatch)

    // 保存备份版本号用于后续迁移
    const backupVersion = parsedData.appInitializationVersion

    // IndexedDB 数据已写入，释放内存
    // @ts-ignore
    parsedData.indexedData = null
    // @ts-ignore
    parsedData = null

    // 设置备份时的版本号（旧备份默认为 1，跳过初始 seed）
    // 然后运行增量迁移（从 backupVersion+1 到 latest）
    const versionToSet = backupVersion ?? 1
    logger.info(`Setting app initialization version to ${versionToSet} and running incremental migrations...`)
    await preferenceService.set('app.initialization_version', versionToSet)
    await runAppDataMigrations()

    // 刷新所有服务缓存，确保使用恢复后的数据
    resetAppInitializationState()

    logger.info('Restore completed successfully')
  } catch (error) {
    logger.error('restore error: ', error)
    throw error
  } finally {
    if (unzipPath) {
      try {
        new Directory(unzipPath).delete()
      } catch (cleanupError) {
        logger.error('Failed to cleanup temporary directory: ', cleanupError)
      }
    }
  }
}

function transformBackupData(data: string): {
  reduxData: ExportReduxData
  indexedData: ExportIndexedData
  appInitializationVersion?: number
} {
  let orginalData: any

  try {
    // 解析主 JSON - 这步无法避免，但可以立即释放原始字符串
    logger.info('Parsing main JSON structure...')
    orginalData = JSON.parse(data)
    // data 参数会在函数返回后自动释放
  } catch (error) {
    logger.error('Failed to parse backup JSON:', error)
    throw new Error('Invalid backup file format')
  }

  // 提取 Redux 数据
  logger.info('Extracting Redux data...')
  let localStorageData = orginalData.localStorage

  // 从 IndexedDB 提取 topics（这是数据的真实来源，包含所有 topics）
  const indexedDb: ImportIndexedData = orginalData.indexedDB

  // 提取 app_initialization_version（旧备份可能没有此字段）
  const appInitializationVersion: number | undefined = orginalData.app_initialization_version

  orginalData = null
  let persistDataString = localStorageData['persist:cherry-studio']
  localStorageData = null
  let rawReduxData = JSON.parse(persistDataString)
  persistDataString = null

  const reduxData: ImportReduxData = {
    assistants: JSON.parse(rawReduxData.assistants),
    llm: JSON.parse(rawReduxData.llm),
    websearch: JSON.parse(rawReduxData.websearch),
    settings: JSON.parse(rawReduxData.settings),
    mcp: rawReduxData.mcp ? JSON.parse(rawReduxData.mcp) : undefined
  }

  rawReduxData = null
  let indexedDbData: ExportIndexedData = {
    topics: [],
    message_blocks: [],
    messages: [],
    settings: indexedDb.settings || []
  }
  // 如果用户选择了恢复消息
  if (indexedDb.topics && indexedDb.message_blocks) {
    logger.info('Processing topics and messages...')
    // 从 Redux 构建 topic 的 assistantId 映射
    const topicsFromRedux = reduxData.assistants.assistants
      .flatMap(a => a.topics)
      .concat(reduxData.assistants.defaultAssistant.topics)

    const topicToAssistantMap = new Map<string, string>()
    for (const topic of topicsFromRedux) {
      topicToAssistantMap.set(topic.id, topic.assistantId)
    }

    const allMessages: Message[] = []
    const messagesByTopicId: Record<string, Message[]> = {}

    // 从 IndexedDB 提取所有 topics 和 messages
    for (const topic of indexedDb.topics) {
      if (topic.messages && topic.messages.length > 0) {
        messagesByTopicId[topic.id] = topic.messages
        allMessages.push(...topic.messages)
      }
    }

    logger.info(`Extracted ${allMessages.length} messages from ${indexedDb.topics.length} topics`)

    // 合并 topics：使用 IndexedDB 的 topics，Redux 的元数据用于筛选脏数据
    const topicsWithMessages = indexedDb.topics
      .map(indexedTopic => {
        // 尝试从 Redux 中获取对应的 topic 元数据
        const reduxTopic = topicsFromRedux.find(t => t.id === indexedTopic.id)

        // 如果redux中不存在，则跳过当前数据
        if (!reduxTopic) {
          return
        }

        return {
          id: indexedTopic.id,
          assistantId: reduxTopic?.assistantId ?? 'default',
          name: reduxTopic?.name ?? 'Untitled Topic',
          createdAt: reduxTopic?.createdAt ?? Date.now(),
          updatedAt: reduxTopic?.updatedAt ?? Date.now(),
          isLoading: reduxTopic?.isLoading ?? false
        } as Topic
      })
      .filter((topic): topic is Topic => topic !== undefined)

    topicToAssistantMap.clear()
    indexedDbData.messages = allMessages
    indexedDbData.topics = topicsWithMessages
    indexedDbData.message_blocks = indexedDb.message_blocks
    logger.info('Backup data transformation completed')
  }

  return {
    reduxData: reduxData,
    indexedData: indexedDbData,
    appInitializationVersion
  }
}

async function getAllData(): Promise<string> {
  try {
    const [providers, webSearchProviders, assistants, topics, messages, messageBlocks, mcpServers] = await Promise.all([
      providerDatabase.getAllProviders(),
      websearchProviderDatabase.getAllWebSearchProviders(),
      assistantService.getExternalAssistants(),
      topicService.getTopics(),
      messageDatabase.getAllMessages(),
      messageBlockDatabase.getAllBlocks(),
      mcpDatabase.getMcps()
    ])

    // Get preferences for backup
    const userName = await preferenceService.get('user.name')
    const userAvatar = await preferenceService.get('user.avatar')
    const searchWithTime = await preferenceService.get('websearch.search_with_time')
    const maxResults = await preferenceService.get('websearch.max_results')
    const overrideSearchService = await preferenceService.get('websearch.override_search_service')
    const contentLimit = await preferenceService.get('websearch.content_limit')
    const appInitializationVersion = await preferenceService.get('app.initialization_version')

    let defaultAssistant: Assistant | null = null

    try {
      defaultAssistant = await assistantService.getAssistant('default')
    } catch (error) {
      logger.warn('Failed to load default assistant from service, falling back to system config.', error)
    }

    if (!defaultAssistant) {
      const systemAssistants = getSystemAssistants()
      defaultAssistant = systemAssistants.find(assistant => assistant.id === 'default') || systemAssistants[0] || null
    }

    const topicsByAssistantId = topics.reduce<Record<string, Topic[]>>((accumulator, topic) => {
      if (!accumulator[topic.assistantId]) {
        accumulator[topic.assistantId] = []
      }

      accumulator[topic.assistantId].push(topic)
      return accumulator
    }, {})

    const defaultAssistantPayload: Assistant = defaultAssistant
      ? {
          ...defaultAssistant,
          topics: topicsByAssistantId[defaultAssistant.id] ?? defaultAssistant.topics ?? []
        }
      : {
          id: 'default',
          name: 'Default Assistant',
          prompt: '',
          topics: topicsByAssistantId['default'] ?? [],
          type: 'system'
        }

    const assistantsWithTopics = assistants.map(assistant => ({
      ...assistant,
      topics: topicsByAssistantId[assistant.id] ?? assistant.topics ?? []
    }))

    const assistantsPayload = {
      defaultAssistant: defaultAssistantPayload,
      assistants: assistantsWithTopics
    }

    const llmPayload = {
      providers
    }

    const websearchPayload = {
      searchWithTime,
      maxResults,
      overrideSearchService,
      contentLimit,
      providers: webSearchProviders
    }

    const settingsPayload = {
      userName
    }

    const mcpPayload = {
      servers: mcpServers
    }

    const persistDataString = JSON.stringify({
      assistants: JSON.stringify(assistantsPayload),
      llm: JSON.stringify(llmPayload),
      websearch: JSON.stringify(websearchPayload),
      settings: JSON.stringify(settingsPayload),
      mcp: JSON.stringify(mcpPayload)
    })

    const localStorage: Record<string, string> = {
      'persist:cherry-studio': persistDataString
    }

    const messagesByTopic = messages.reduce<Record<string, Message[]>>((accumulator, message) => {
      if (!accumulator[message.topicId]) {
        accumulator[message.topicId] = []
      }

      accumulator[message.topicId].push(message)
      return accumulator
    }, {})

    const indexedSettings: Setting[] = userAvatar
      ? [
          {
            id: 'image://avatar',
            value: userAvatar
          }
        ]
      : []

    const indexedDB: ImportIndexedData = {
      topics: topics.map(topic => ({
        id: topic.id,
        messages: messagesByTopic[topic.id] ?? []
      })),
      message_blocks: messageBlocks,
      settings: indexedSettings
    }

    const backupData = JSON.stringify({
      time: Date.now(),
      version: 5,
      app_initialization_version: appInitializationVersion,
      indexedDB,
      localStorage: localStorage
    })

    return backupData
  } catch (error) {
    logger.error('Error occurred during backup', error)
    throw error
  }
}

async function zipBackupData(backupData: string) {
  if (!DEFAULT_BACKUP_STORAGE.exists) {
    DEFAULT_BACKUP_STORAGE.create({ intermediates: true, idempotent: true })
  }

  const tempDirectory = new Directory(DEFAULT_BACKUP_STORAGE, `tmp-${Date.now()}`)
  tempDirectory.create({ intermediates: true })

  try {
    const dataFile = new File(tempDirectory, 'data.json')

    if (dataFile.exists) {
      dataFile.delete()
    }

    dataFile.write(backupData)

    const filename = `cherry-studio.${dayjs().format('YYYYMMDDHHmm')}.zip`
    const zipFile = new File(DEFAULT_BACKUP_STORAGE, filename)

    if (zipFile.exists) {
      zipFile.delete()
    }

    await zip([dataFile.uri], zipFile.uri)

    return zipFile.uri
  } catch (error) {
    logger.error('Failed to create backup zip:', error)
    throw error
  } finally {
    try {
      tempDirectory.delete()
    } catch (cleanupError) {
      logger.error('Failed to cleanup temporary backup directory:', cleanupError)
    }
  }
}

export async function backup() {
  // 1. 获取备份数据 json格式
  // 主要备份 providers websearchProviders assistants
  // topics messages message_blocks settings
  const backupData = await getAllData()
  // 2. 保存到zip中
  const backupFile = await zipBackupData(backupData)
  // 3. 返回文件路径
  return backupFile
}
