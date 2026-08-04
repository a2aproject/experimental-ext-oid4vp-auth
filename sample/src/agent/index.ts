/**
 * Copyright (c) 2026 DSR Corporation, Denver, Colorado.
 * https://www.dsr-corporation.com
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Express } from 'express'
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, AgentCard, Role, Task, TaskState } from '@a2a-js/sdk'
import {
  AgentEvent,
  AgentExecutor,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
  TaskStore,
} from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
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
import { agentText, bindOrExit, partsToText, requireEnv, statusEvent, textPart, uuid } from '../a2a-helpers'

dotenv.config()

requireEnv('OPENAI_API_KEY')

const SAMPLE_AGENT_PORT = Number(process.env.SAMPLE_AGENT_PORT) || 10003
const VERIFIER_PORT = Number(process.env.SAMPLE_AGENT_VERIFIER_PORT) || 3001

// How long the agent waits for the user to present a credential before failing the task
const AUTH_TIMEOUT_MS = Number(process.env.SAMPLE_AGENT_AUTH_TIMEOUT_MS) || 120000

const SAMPLE_AGENT_CARD: AgentCard = {
  name: 'Sample Agent',
  description: 'A sample agent that can answer questions about decentralized identity.',
  supportedInterfaces: [
    {
      protocolBinding: 'JSONRPC',
      protocolVersion: A2A_PROTOCOL_VERSION,
      url: `http://localhost:${SAMPLE_AGENT_PORT}/`,
      tenant: '',
    },
  ],
  provider: {
    organization: 'A2A Samples',
    url: 'https://example.com/a2a-samples',
  },
  version: '1.0.0',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extendedAgentCard: false,
    extensions: [
      {
        uri: IN_TASK_OID4VP_EXTENSION_URI,
        description: 'Provides an option to use OpenID for Verifiable Presentations (OID4VP) for In-Task Authorization',
        required: false,
        params: { oid4vpVersions: ['1.0'] },
      } satisfies InTaskOpenId4VpExtension,
    ],
  },
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
      securityRequirements: [],
    },
  ],
  securitySchemes: {},
  securityRequirements: [],
  signatures: [],
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
  private readonly authWaiters = new Map<string, () => void>()

  private readonly credoExpressApp: Express = express()
  private readonly credoAgent: CredoAgentWithOpenId4Vc

  constructor() {
    this.credoAgent = createCredoAgent('sample-agent', this.credoExpressApp, VERIFIER_PORT)
  }

  public async initialize(): Promise<void> {
    await this.credoAgent.initialize()

    await createDidKidVerificationMethod(this.credoAgent.context, ISSUER_SECRET_KEY)

    this.credoAgent.events.on(
      OpenId4VcVerifierEvents.VerificationSessionStateChanged,
      this.onOid4VcVerificationSessionStateChange.bind(this)
    )

    // A stale process on this port would silently serve the wrong verifier and 404 every presentation.
    bindOrExit(this.credoExpressApp, VERIFIER_PORT, 'SampleAgent', () => {
      console.log(`[SampleAgent] OID4VP verifier listening on http://localhost:${VERIFIER_PORT}/oid4vp`)
    })
  }

  public cancelTask = async (taskId: string): Promise<void> => {
    this.cancelledTasks.add(taskId)
  }

  public async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage
    const existingTask = requestContext.task

    const taskId = requestContext.taskId
    const contextId = requestContext.contextId

    console.log(
      `[SampleAgentExecutor] Processing message ${userMessage.messageId} for task ${taskId} (context: ${contextId})`
    )

    if (requestContext.context.requestedExtensions?.includes(IN_TASK_OID4VP_EXTENSION_URI)) {
      requestContext.context.addActivatedExtension(IN_TASK_OID4VP_EXTENSION_URI)
    } else {
      console.warn(
        `[SampleAgentExecutor] Client did not request ${IN_TASK_OID4VP_EXTENSION_URI}, so it will not understand the authorization request.`
      )
    }

    const task: Task = existingTask ?? {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    }
    eventBus.publish(AgentEvent.task(task))

    if (!this.authorizedContexts.has(contextId)) {
      try {
        await this.requestAndAwaitAuthorization(taskId, contextId, eventBus)
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'authorization did not complete'
        console.error(`[SampleAgentExecutor] Authorization failed for context ${contextId}:`, error)
        eventBus.publish(
          AgentEvent.statusUpdate(
            statusEvent(
              taskId,
              contextId,
              TaskState.TASK_STATE_FAILED,
              agentText(taskId, contextId, `Authorization was not completed (${reason}).`)
            )
          )
        )
        return
      }
    }

    eventBus.publish(
      AgentEvent.statusUpdate(
        statusEvent(taskId, contextId, TaskState.TASK_STATE_WORKING, agentText(taskId, contextId, 'Thinking...'))
      )
    )

    const history = existingTask?.history ? [...existingTask.history] : []
    if (!history.some((message) => message.messageId === userMessage.messageId)) {
      history.push(userMessage)
    }

    const messages: MessageData[] = history
      .map((message) => ({
        role: (message.role === Role.ROLE_AGENT ? 'model' : 'user') as 'user' | 'model',
        content: [{ text: partsToText(message.parts) }].filter((part) => part.text.length > 0),
      }))
      .filter((message) => message.content.length > 0)

    if (messages.length === 0) {
      console.warn(`[SampleAgentExecutor] No valid text messages found in history for task ${taskId}.`)
      eventBus.publish(
        AgentEvent.statusUpdate(
          statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_FAILED,
            agentText(taskId, contextId, 'No messages found to process.')
          )
        )
      )
      return
    }

    try {
      const response = await sampleAgentPrompt({}, { messages })

      if (this.cancelledTasks.has(taskId)) {
        console.log(`[SampleAgentExecutor] Request cancelled for task: ${taskId}`)
        eventBus.publish(
          AgentEvent.statusUpdate(statusEvent(taskId, contextId, TaskState.TASK_STATE_CANCELED, undefined))
        )
        return
      }

      const responseText = response.text
      console.info(`[SampleAgentExecutor] Prompt response: ${responseText}`)

      eventBus.publish(
        AgentEvent.statusUpdate(
          statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_COMPLETED,
            agentText(taskId, contextId, responseText || 'Completed.')
          )
        )
      )

      console.log(`[SampleAgentExecutor] Task ${taskId} finished with state: completed`)
    } catch (error: unknown) {
      console.error(`[SampleAgentExecutor] Error processing task ${taskId}:`, error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      eventBus.publish(
        AgentEvent.statusUpdate(
          statusEvent(
            taskId,
            contextId,
            TaskState.TASK_STATE_FAILED,
            agentText(taskId, contextId, `Agent error: ${errorMessage}`)
          )
        )
      )
    }
  }

  private async requestAndAwaitAuthorization(
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const authorizationRequest = await this.createAuthorizationRequestForContext(contextId)

    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          message: {
            messageId: uuid(),
            contextId,
            taskId,
            role: Role.ROLE_AGENT,
            parts: [textPart('Additional authorization is required for this task.')],
            metadata: {
              [IN_TASK_OID4VP_EXTENSION_URI]: {
                authorizationRequest,
              } satisfies InTaskOpenId4VpMessageMetadata,
            },
            extensions: [IN_TASK_OID4VP_EXTENSION_URI],
            referenceTaskIds: [],
          },
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      })
    )

    await this.waitForContextAuthorization(contextId)
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

    const contextId = verificationSession.getTag('contextId')
    if (typeof contextId !== 'string' || !contextId) return

    this.authorizedContexts.add(contextId)

    const waiter = this.authWaiters.get(contextId)
    if (waiter) {
      this.authWaiters.delete(contextId)
      waiter()
    }
  }

  private waitForContextAuthorization(contextId: string, timeoutMs: number = AUTH_TIMEOUT_MS): Promise<void> {
    if (this.authorizedContexts.has(contextId)) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        // Only clear our own waiter - a newer request for this context may have replaced it.
        if (this.authWaiters.get(contextId) === waiter) this.authWaiters.delete(contextId)
        reject(new Error('authorization timeout exceeded'))
      }, timeoutMs)
      this.authWaiters.set(contextId, waiter)
    })
  }
}

async function main() {
  const taskStore: TaskStore = new InMemoryTaskStore()
  const agentExecutor: SampleAgentExecutor = new SampleAgentExecutor()

  await agentExecutor.initialize()

  const requestHandler = new DefaultRequestHandler(
    SAMPLE_AGENT_CARD,
    taskStore,
    agentExecutor,
    new DefaultExecutionEventBusManager()
  )

  const expressApp = express()
  expressApp.use(express.json())
  expressApp.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }))
  expressApp.use('/', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }))

  bindOrExit(expressApp, SAMPLE_AGENT_PORT, 'SampleAgent', () => {
    console.log(`[SampleAgent] Server started on http://localhost:${SAMPLE_AGENT_PORT}`)
    console.log(`[SampleAgent] Agent Card: http://localhost:${SAMPLE_AGENT_PORT}/${AGENT_CARD_PATH}`)
    console.log('[SampleAgent] Press Ctrl+C to stop the server')
  })
}

main().catch(console.error)
