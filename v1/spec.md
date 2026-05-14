# A2A Protocol Extension: OID4VP In-Task Authorization (v1 Draft)

- **URI:** `https://github.com/a2aproject/experimental-ext-oid4vp-auth/tree/main/v1`
- **Type:** Profile Extension / Data-Only Extension
- **Version:** 1.0.0 (Draft)
- **Authors**: [Alexander Shcherbakov](https://github.com/ashcherbakov) (DSR Corporation), [Valentine Mazurov](https://github.com/Vanderkast) (DSR Corporation), [Alexander Shenshin](https://github.com/AlexanderShenshin) (DSR Corporation)

## Abstract

This extension provides an option to use [OpenID for Verifiable Presentations (OID4VP) protocol](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html) for Agent2Agent (A2A) In-Task Authorization.

The integration of OID4VP flow allows Server Agents to perform additional authorization by requesting Verifiable Presentations (VPs) from the client.
This mechanism also enables Just-In-Time (JIT) authorization – server can dynamically request information from specific Verifiable Credentials (VCs) during a Task execution without breaking the protocol flow.

It's also worth mentioning that support for OID4VP-based auth is highly relevant for adoption of A2A in ecosystems that use / support trust models based on VCs.

## OID4VP In-Task Authorization Flow

The diagram below shows a non-normative example of an OID4VP A2A in-task authorization flow:

```mermaid
sequenceDiagram
    participant C as A2A Client 
    participant S as A2A Server 
    participant V as OID4VP Verifier 
    participant W as OID4VP Wallet
    
    C -->> S: O-O-B Communication 
    S ->> C: Additional authorization needed<br/>Task status: TASK_STATE_AUTH_REQUIRED<br/>Message response with authorizationRequest object
    C ->> W: OID4VP Wallet invocation
    W ->> V: Requests Authorization Request 
    V ->> W: Authorization Request
    W ->> W: Requests End-User consent (if applicable)
    W ->> W: Creates a Verifiable Presentation (VP) that matches Authorization Request
    W ->> V: VP
    V ->> V: Verifies VP
    V ->> S: Approves task execution (out-of-band)
    S ->> C: Additional authorization passed<br/>Task status: TASK_STATE_WORKING<br/>(received via Task subscription or status polling)
```

### Assumptions
- The distinction between roles in this flow is logical (OID4VP Verifier can be embedded in A2A Server, etc.)
- OID4VP Wallet invocation is out of scope for this extension, you can find implementation considerations in [corresponding section](#wallet-invocation)
- Requesting End-User consent from a Wallet is out of scope for this extension
- Interactions between OID4VP Wallet and OID4VP Verifier are performed according to OID4VP specification and out of scope for this extension

## Protocol Data Definition

An A2A Agent that supports OID4VP In-Task authorization mechanisms **MUST** declare its support in its `AgentCard` under the **`extensions`** part of the `AgentCapabilities` object.

### Example AgentCard Declaration

The extension requires `oid4vpVersions` parameter that explicitly specifies OID4VP versions supported by the Agent.

```json
{
  "uri": "https://github.com/a2aproject/experimental-ext-oid4vp-auth/tree/main/v1",
  "description": "Provides an option to use OpenID for Verifiable Presentations (OID4VP) for In-Task Authorization",
  "required": false,
  "params": {
    "oid4vpVersions": ["1.0"]
  }
}
```

## Data Structure: Authorization Request

The A2A Authorization Request object is passed from Server Agent to the Client to initiate OID4VP flow, data structure is defined according to [Section 5 of OID4VP specification](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-authorization-request).
It's included in the `metadata` map of a core A2A message structure as a top-level `authorizationRequest` object.

| Field             | Type     | Required                                                         | Description                                                                        |
|:------------------|:---------|:-----------------------------------------------------------------|:-----------------------------------------------------------------------------------|
| **`client_id`**   | `string` | Yes                                                              | OAuth 2.0 client ID. The value MUST match the `request` or `request_uri` client_id |
| **`request_uri`** | `string` | Yes, if `request` is not specified. Otherwise MUST NOT present   | The absolute URI referencing authorization request parameters                      |
| **`request`**     | `object` | Yes, if `request_uri` is not defined. Otherwise MUST NOT present | The Request Object that contains authorization request parameters                  |

### Example Authorization Request Payload

```json
{
  "client_id": "client-id",
  "request_uri": "request-uri"
}
```

### Example A2A Message Response with Authorization Request metadata

```json
{
  "task": {
    "id": "task-uuid",
    "status": {
      "state": "TASK_STATE_AUTH_REQUIRED",
      "message": {
        "role": "ROLE_AGENT",
        "parts": [{"text": "Additional authorization is required for this task."}],
        "metadata": {
          "https://github.com/a2aproject/experimental-ext-oid4vp-auth/tree/main/v1": {
            "authorizationRequest": {
              "client_id": "client-id",
              "request_uri": "request-uri"
            }
          }
        }
      }
    }
  }
}
```

## Implementation Considerations

### Wallet Invocation

This specification considers two general cases for Verifiable Credentials (VCs) ownership and A2A Client <-> OID4VP Wallet integration:
- **End-User is a Holder of VCs**, so that A2A Client interacts with a Wallet application controlled by End-User (such as Google or Apple Wallet)
- **A2A Client Agent is a Holder of VCs**, directly controls the Wallet and can present VCs independently

Approaches for the Wallet Invocation process depend on cases described above:

#### End-User is a Holder of VCs

In this scenario, End-User Wallet is a standalone application that needs to be invoked using one of the following mechanisms in accordance with [Section 9 of OID4VP specification](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#wallet-invocation):
- Custom URL scheme as an `authorization_endpoint` (for example, `openid4vp://`)
- URL (including Domain-bound Universal Links/App link) as an `authorization_endpoint`

If A2A Client and OID4VP Wallet parties are hosted on different devices (cross-device flow), the following options to convey data between devices should be considered:
- OID4VC Wallet can be invoked using the Digital Credentials API as described in [Appendix A of OID4VP specification](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#dc_api). This option is RECOMMENDED as it provides significant benefits for privacy, security and user experience
- Either of the above mechanisms may be presented as QR-code for the End-User to scan using OID4VC Wallet app or arbitrary camera application on a device (commonly used with [`direct_post` response type in OID4VP](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-response-mode-direct_post))

#### A2A Client Agent is a Holder of VCs

This scenario assumes direct control of A2A Client Agent over a Wallet application / module via Model Context Protocol (MCP) or other integration mechanisms.

We can assume the following general flow for Wallet Invocation (simplified):
1. A2A Client Agent receives an Authorization Request from A2A Server
2. A2A Client invokes a Wallet application / module (e.g., by calling MCP tool) and passes `authorizationRequest` object for processing
3. The Wallet proceeds with OID4VP flow, this step may include out-of-band communication with A2A Client Agent (VC selection and confirmation, etc.)

Technical details and further breakdown of this flow are implementation-specific.

## E2E flow example

OID4VP In-Task auth flow and messages based on sample provided in [corresponding repo folder](../sample).

### Assumptions for scenario simplicity
- A2A Client manages its own Verifiable Credentials Wallet and has pre-issued `Sample Credential` - issuance is out of scope
- A2A Server has built-in capabilities to act as Verifiable Credentials Verifier
- OID4VP Authorization Request parameters are the same in each context, do not depend on A2A Task data or other external factors

A2A Client credential payload:
```json
{
  "vct": "SampleCredential",
  "university": "innsbruck",
  "degree": "bachelor",
  "name": "John Doe"
}
```

#### 1. A2A Client sends a new Task request to A2A Server
#### 2. A2A Server decides that additional authorization is required -> OOB interaction with OID4VP Verifier -> OID4VP Verifier generates OID4VP Authorization request

Digital Credentials Query Language (DCQL) query for `SampleCredential` used for OID4VP Authorization Request:
```json
{
  "credentials": [
    {
      "id": "SampleCredential",
      "format": "vc+sd-jwt",
      "meta": { "vct_values": ["SampleCredential"] },
      "claims": [{ "path": ["name"] }]
    }
  ]
}
```

#### 3. A2A Server receives OID4VP authorization request from OID4VP Verifier (OOB) and sends `auth-required` response to A2A Client

Example extension metadata included in the response:
```json
{
  "https://github.com/a2aproject/experimental-ext-oid4vp-auth/tree/main/v1": {
    "authorizationRequest": {
      "request_uri": "openid4vp://?response_type=vp_token&client_id=redirect_uri%3Ahttp%3A%2F%2Flocalhost%3A3001%2Foid4vp%2F5567d2bd-b272-4ba1-b8c2-d6be1e98f6c4%2Fauthorize%3Fsession%3Db86bd3f3-76d4-4bf1-80fa-82295514cb4a&response_uri=http%3A%2F%2Flocalhost%3A3001%2Foid4vp%2F5567d2bd-b272-4ba1-b8c2-d6be1e98f6c4%2Fauthorize%3Fsession%3Db86bd3f3-76d4-4bf1-80fa-82295514cb4a&response_mode=direct_post&nonce=oGhS046x9Aeph0vltNFB5BGOqVmBWZbJdTAGhKZhvEs&dcql_query=%7B%22credentials%22%3A%5B%7B%22id%22%3A%22SampleCredential%22%2C%22format%22%3A%22vc%2Bsd-jwt%22%2C%22meta%22%3A%7B%22vct_values%22%3A%5B%22SampleCredential%22%5D%7D%2C%22claims%22%3A%5B%7B%22path%22%3A%5B%22name%22%5D%7D%5D%7D%5D%7D&client_metadata=%7B%22vp_formats_supported%22%3A%7B%22vc%2Bsd-jwt%22%3A%7B%22alg_values%22%3A%5B%22ES256%22%2C%22ES384%22%2C%22EdDSA%22%2C%22Ed25519%22%2C%22ES256K%22%5D%7D%7D%2C%22response_types_supported%22%3A%5B%22vp_token%22%5D%7D&state=HMaS3mGHyQjwVfkofhLsKqabIBbJ1vnECl6zrwfgpq0",
      "client_id": "redirect_uri:http://localhost:3001/oid4vp/5567d2bd-b272-4ba1-b8c2-d6be1e98f6c4/authorize?session=b86bd3f3-76d4-4bf1-80fa-82295514cb4a"
    }
  }
}
```

#### 4. A2A Client receives `auth-required` response and initiates OID4VP Wallet invocation -> OID4VP Wallet creates and sends OID4VP authorization response to OID4VP Verifier

Example OID4VP authorization response:
```json
{
  "vp_token": {
    "SampleCredential": [
      "eyJ0eXAiOiJkYytzZC1qd3QiLCJhbGciOiJFZERTQSIsImtpZCI6IiN6Nk1rcEdSNGdzNFJjM1pwaDR2ajh3Um5qbkF4Z0FQU3hjUjhNQVZLdXRXc3BRemMifQ.eyJ2Y3QiOiJEZW1vQ3JlZGVudGlhbCIsImRlZ3JlZSI6ImJhY2hlbG9yIiwiY25mIjp7ImtpZCI6ImRpZDprZXk6ejZNa3NLeGtmVE1TUFo5b3JrZVZtWGFYYXY5R3BkZjZoNW9zTGVWOWc3a1V2cll3I3o2TWtzS3hrZlRNU1BaOW9ya2VWbVhhWGF2OUdwZGY2aDVvc0xlVjlnN2tVdnJZdyJ9LCJpc3MiOiJkaWQ6a2V5Ono2TWtwR1I0Z3M0UmMzWnBoNHZqOHdSbmpuQXhnQVBTeGNSOE1BVkt1dFdzcFF6YyIsImlhdCI6MTc3MTgxNDUxNywiX3NkIjpbIjdGNmpVd05nOFZvS0RXQ2ROSm1WRThXSG1ULTlZOFhuOElRb1B2bVNoTVEiLCJ4QkQ4VVJfWUdqMkpieEh2Rld6WUQ2enFLZEF4bzVKWjdwTDFlUWtLX1JNIl0sIl9zZF9hbGciOiJzaGEtMjU2In0.32t6v5DdC_olJBe9lXJWXn8FLR0i9xirNDSeL_fK3FA1PIc5WrE2GsDFBxmJHur3EsEch2MPTuaGoXeVjTVRBg~WyJ6LWRELVFld1VvVF9VckpTIiwibmFtZSIsIkpvaG4gRG9lIl0~eyJ0eXAiOiJrYitqd3QiLCJhbGciOiJFZERTQSJ9.eyJpYXQiOjE3NzE4MTQ1MjIsIm5vbmNlIjoib2Vxd01sOENKZTFNdnVDLTBEaWM0SWFfUzBWU2g3ZXA1cUlEQlY5cm5aQSIsImF1ZCI6InJlZGlyZWN0X3VyaTpodHRwOi8vbG9jYWxob3N0OjMwMDEvb2lkNHZwLzU1NjdkMmJkLWIyNzItNGJhMS1iOGMyLWQ2YmUxZTk4ZjZjNC9hdXRob3JpemU_c2Vzc2lvbj0wMzk4MDViNC0zNjg5LTRiMDEtYmZjNC02MjYwOGY4NjY1NzkiLCJzZF9oYXNoIjoiS2cyM01OOUlVcFByYjdOS3dZZm9qUmJVSFg0dU5qbFZBbDM4OWRfUzIyZyJ9.mkskJQqOGXR93GNCyuJaZh5ZaGgjxVumpOcHCqTOSffEIaUUd_SGmSLVrPk-imi_YHgpd7o2StkOqTv90BSaCg"
    ]
  },
  "state": "Qt0XDdw_dG_lV65trStQ8IRYmwUX_6jgmjGKCMnfnnk"
}
```

#### 5. OID4VP Verifier receives an authorization response, verifies it and approves the execution (OOB interaction with A2A Server)