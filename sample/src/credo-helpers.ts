/**
 * Copyright (c) 2026 DSR Corporation, Denver, Colorado.
 * https://www.dsr-corporation.com
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent as CredoAgent,
  LogLevel,
  ConsoleLogger,
  AgentContext,
  DidsApi,
  TypedArrayEncoder,
  DidKey,
  Kms,
  KeyDidCreateOptions,
} from '@credo-ts/core'
import { agentDependencies } from '@credo-ts/node'
import { AskarModule, transformPrivateKeyToPrivateJwk } from '@credo-ts/askar'
import { askarNodeJS } from '@openwallet-foundation/askar-nodejs'
import { OpenId4VcModule } from '@credo-ts/openid4vc'
import { Express } from 'express'

export const HOLDER_SECRET_KEY = '86213c3d7fc8d4d6754c7a0fd969598e'
export const ISSUER_SECRET_KEY = '96213c3d7fc8d4d6754c7a0fd969598e'

export type CredoAgentWithOpenId4Vc = CredoAgent<{ openid4vc: OpenId4VcModule }>

export function createCredoAgent(
  agentName: string,
  expressApp: Express,
  oid4vcPort: number = 3000
): CredoAgentWithOpenId4Vc {
  const oid4vcBaseUrl = `http://localhost:${oid4vcPort}`

  return new CredoAgent({
    config: {
      logger: new ConsoleLogger(LogLevel.info),
      allowInsecureHttpUrls: true,
    },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar: askarNodeJS,
        store: {
          id: agentName,
          key: 'key',
          database: {
            type: 'sqlite',
            config: {
              inMemory: true,
            },
          },
        },
      }),
      openid4vc: new OpenId4VcModule({
        app: expressApp,
        verifier: {
          baseUrl: `${oid4vcBaseUrl}/oid4vp`,
        },
      }),
    },
  })
}

export async function createDidKidVerificationMethod(agentContext: AgentContext, secretKey?: string) {
  const dids = agentContext.dependencyManager.resolve(DidsApi)
  const kms = agentContext.dependencyManager.resolve(Kms.KeyManagementApi)

  const { keyId, publicJwk } = secretKey
    ? await kms.importKey({
        privateJwk: transformPrivateKeyToPrivateJwk({
          type: {
            kty: 'OKP',
            crv: 'Ed25519',
          },
          privateKey: TypedArrayEncoder.fromString(secretKey),
        }).privateJwk,
      })
    : await kms.createKey({
        type: {
          kty: 'OKP',
          crv: 'Ed25519',
        },
      })

  const didCreateResult = await dids.create<KeyDidCreateOptions>({
    method: 'key',
    options: { keyId },
  })

  const did = didCreateResult.didState.did as string
  const didKey = DidKey.fromDid(did)
  const kid = `${did}#${didKey.publicJwk.fingerprint}`

  const verificationMethod = didCreateResult.didState.didDocument?.dereferenceKey(kid, ['authentication'])
  if (!verificationMethod) throw new Error('No verification method found')

  return { did, kid, verificationMethod, publicJwk: Kms.PublicJwk.fromPublicJwk(publicJwk) }
}
