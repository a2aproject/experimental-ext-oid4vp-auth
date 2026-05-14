/**
 * Copyright (c) 2026 DSR Corporation, Denver, Colorado.
 * https://www.dsr-corporation.com
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Express } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { AgentCard, Message, TaskStatusUpdateEvent, TextPart } from '@a2a-js/sdk'
import {
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
  TaskStore,
} from '@a2a-js/sdk/server'
import { A2AExpressApp } from '@a2a-js/sdk/server/express'
import { MessageData } from 'genkit'
import { ai } from './genkit.js'

import * as dotenv from 'dotenv'
import {
  createCredoAgent,
  createDidKidVerificationMethod,
  CredoAgentWithOpenId4Vc,
  ISSUER_SECRET_KEY,
} from '../credo-helpers'
import {
  OpenId4VcVerificationSessionRepository,
  OpenId4VcVerificationSessionState,
  OpenId4VcVerificationSessionStateChangedEvent,
  OpenId4VcVerifierEvents,
  OpenId4VcVerifierRecord,
} from '@credo-ts/openid4vc'
import { ClaimFormat, DcqlQuery } from '@credo-ts/core'
import {
  IN_TASK_OID4VP_EXTENSION_URI,
  InTaskOpenId4VpAuthorizationRequest,
  InTaskOpenId4VpExtension,
  InTaskOpenId4VpMessageMetadata,
} from '../extension'

dotenv.config()

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY environment variable is not set.')
  throw new Error('OPENAI_API_KEY environment variable is not set.')
}

const SAMPLE_AGENT_CARD: AgentCard = {
  name: 'Sample Agent',
  description: 'A sample agent that can answer questions about decentralized identity.',
  url: 'http://localhost:10003/',
  provider: {
    organization: 'A2A Samples',
    url: 'https://example.com/a2a-samples',
  },
  version: '1.0.0',
  protocolVersion: '1.0',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
    extensions: [
      {
        uri: IN_TASK_OID4VP_EXTENSION_URI,
        description: 'Provides an option to use OpenID for Verifiable Presentations (OID4VP) for In-Task Authorization',
        required: false,
        params: { oid4vpVersions: ['1.0'] },
      } satisfies InTaskOpenId4VpExtension,
    ],
  },
  securitySchemes: undefined,
  security: undefined,
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'assistant',
      name: 'Advising on decentralized identity',
      description: 'Answers questions about decentralized identity',
      tags: ['assistant'],
      examples: ['What is OID4VP?'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
}

const sampleAgentPrompt = ai.prompt('sample_agent')

const DCQL_QUERY = {
  credentials: [
    {
      id: 'SampleCredential',
      format: ClaimFormat.SdJwtW3cVc,
      meta: { vct_values: ['SampleCredential'] },
      claims: [{ path: ['name'] }],
    },
  ],
} satisfies DcqlQuery

class SampleAgentExecutor implements AgentExecutor {
  private readonly cancelledTasks = new Set<string>()
  private readonly authorizedContexts = new Set<string>()

  private readonly credoExpressApp: Express = express()
  private readonly credoAgent: CredoAgentWithOpenId4Vc

  constructor() {
    this.credoAgent = createCredoAgent('sample-agent', this.credoExpressApp, 3001)
  }

  public async initialize(): Promise<void> {
    await this.credoAgent.initialize()

    await createDidKidVerificationMethod(this.credoAgent.context, ISSUER_SECRET_KEY)

    this.credoAgent.events.on(
      OpenId4VcVerifierEvents.VerificationSessionStateChanged,
      this.onOid4VcVerificationSessionStateChange.bind(this)
    )
    this.credoExpressApp.listen(3001)
  }

  public cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    this.cancelledTasks.add(taskId)
  }

  public async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage
    let task = requestContext.task

    const taskId = task?.id || uuidv4()
    const contextId = userMessage.contextId || task?.contextId || uuidv4()

    console.log(
      `[SampleAgentExecutor] Processing message ${userMessage.messageId} for task ${taskId} (context: ${contextId})`
    )

    if (!task) {
      task = {
        kind: 'task',
        id: taskId,
        contextId,
        status: {
          state: 'submitted',
          timestamp: new Date().toISOString(),
        },
        history: [userMessage],
        metadata: userMessage.metadata,
      }
      eventBus.publish(task)
    }

    if (!this.authorizedContexts.has(contextId)) {
      const authorizationRequest = await this.createAuthorizationRequestForContext(contextId)

      const authRequiredStatusUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'auth-required',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: uuidv4(),
            parts: [{ kind: 'text', text: 'Additional authorization is required for this task.' }],
            taskId,
            contextId,
            metadata: {
              [IN_TASK_OID4VP_EXTENSION_URI]: {
                authorizationRequest,
              } satisfies InTaskOpenId4VpMessageMetadata,
            },
          },
          timestamp: new Date().toISOString(),
        },
        final: false,
      }

      eventBus.publish(authRequiredStatusUpdate)
      await this.waitForContextAuthorization(contextId)
    }

    const workingStatusUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          role: 'agent',
          messageId: uuidv4(),
          parts: [{ kind: 'text', text: 'Thinking...' }],
          taskId,
          contextId,
        },
        timestamp: new Date().toISOString(),
      },
      final: false,
    }
    eventBus.publish(workingStatusUpdate)

    const historyForGenkit = task?.history ? [...task.history] : []
    if (!historyForGenkit.find((m) => m.messageId === userMessage.messageId)) {
      historyForGenkit.push(userMessage)
    }

    const messages: MessageData[] = historyForGenkit
      .map((message) => ({
        role: (message.role === 'agent' ? 'model' : 'user') as 'user' | 'model',
        content: message.parts
          .filter((part): part is TextPart => part.kind === 'text' && !!part.text)
          .map((part) => ({
            text: part.text,
          })),
      }))
      .filter((message) => message.content.length > 0)

    if (messages.length === 0) {
      console.warn(`[SampleAgentExecutor] No valid text messages found in history for task ${taskId}.`)
      const failureUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: uuidv4(),
            parts: [{ kind: 'text', text: 'No messages found to process.' }],
            taskId,
            contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      }
      eventBus.publish(failureUpdate)
      return
    }

    try {
      const response = await sampleAgentPrompt(
        {},
        {
          messages,
        }
      )

      if (this.cancelledTasks.has(taskId)) {
        console.log(`[SampleAgentExecutor] Request cancelled for task: ${taskId}`)

        const cancelledUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'canceled',
            timestamp: new Date().toISOString(),
          },
          final: true,
        }
        eventBus.publish(cancelledUpdate)
        return
      }

      const responseText = response.text
      console.info(`[SampleAgentExecutor] Prompt response: ${responseText}`)

      const agentMessage: Message = {
        kind: 'message',
        role: 'agent',
        messageId: uuidv4(),
        parts: [{ kind: 'text', text: responseText || 'Completed.' }],
        taskId,
        contextId,
      }

      const finalUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'completed',
          message: agentMessage,
          timestamp: new Date().toISOString(),
        },
        final: true,
      }
      eventBus.publish(finalUpdate)

      console.log(`[SampleAgentExecutor] Task ${taskId} finished with state: completed`)
    } catch (error: unknown) {
      console.error(`[SampleAgentExecutor] Error processing task ${taskId}:`, error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      const errorUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: uuidv4(),
            parts: [{ kind: 'text', text: `Agent error: ${errorMessage}` }],
            taskId,
            contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      }
      eventBus.publish(errorUpdate)
    }
  }

  private async createAuthorizationRequestForContext(contextId: string): Promise<InTaskOpenId4VpAuthorizationRequest> {
    const verificationSessionRepository = this.credoAgent.dependencyManager.resolve(
      OpenId4VcVerificationSessionRepository
    )
    const { verifierId } = await this.getOrCreateVerifierRecord()

    const {
      authorizationRequest: request_uri,
      authorizationRequestObject: request,
      verificationSession,
    } = await this.credoAgent.openid4vc.verifier.createAuthorizationRequest({
      verifierId,
      responseMode: 'direct_post',
      requestSigner: {
        method: 'none',
      },
      dcql: {
        query: DCQL_QUERY,
      },
      version: 'v1',
    })

    verificationSession.setTag('contextId', contextId)
    await verificationSessionRepository.update(this.credoAgent.context, verificationSession)

    return { request_uri, client_id: request.client_id }
  }

  private async getOrCreateVerifierRecord(): Promise<OpenId4VcVerifierRecord> {
    const records = await this.credoAgent.openid4vc.verifier.getAllVerifiers()
    return records.length > 0 ? records[0] : await this.credoAgent.openid4vc.verifier.createVerifier()
  }

  private onOid4VcVerificationSessionStateChange(event: OpenId4VcVerificationSessionStateChangedEvent) {
    const { verificationSession } = event.payload
    if (verificationSession.state !== OpenId4VcVerificationSessionState.ResponseVerified) return

    const contextId = verificationSession.getTag('contextId') as string | undefined
    if (contextId) this.authorizedContexts.add(contextId)
  }

  private async waitForContextAuthorization(contextId: string, timeoutMs: number = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      setTimeout(() => reject('Authorization timeout exceeded.'), timeoutMs)
      this.credoAgent.events.on(
        OpenId4VcVerifierEvents.VerificationSessionStateChanged,
        (event: OpenId4VcVerificationSessionStateChangedEvent) => {
          const { verificationSession } = event.payload
          if (verificationSession.state !== OpenId4VcVerificationSessionState.ResponseVerified) return

          if (verificationSession.getTag('contextId') === contextId) resolve()
        }
      )
    })
  }
}

async function main() {
  const taskStore: TaskStore = new InMemoryTaskStore()
  const agentExecutor: SampleAgentExecutor = new SampleAgentExecutor()

  await agentExecutor.initialize()

  const requestHandler = new DefaultRequestHandler(SAMPLE_AGENT_CARD, taskStore, agentExecutor)

  const appBuilder = new A2AExpressApp(requestHandler)
  const expressApp = appBuilder.setupRoutes(express())

  const PORT = process.env.SAMPLE_AGENT_PORT || 10003

  expressApp.listen(PORT, () => {
    console.log(`[SampleAgent] Server using new framework started on http://localhost:${PORT}`)
    console.log(`[SampleAgent] Agent Card: http://localhost:${PORT}/.well-known/agent-card.json`)
    console.log('[SampleAgent] Press Ctrl+C to stop the server')
  })
}

main().catch(console.error)
