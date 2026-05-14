# OID4VP In-Task Authorization Extension Sample

The provided sample is built using [Genkit](https://genkit.dev/) with the OpenAI API and based on [corresponding JS sample in A2A Samples repo](https://github.com/a2aproject/a2a-samples/tree/main/samples/js).
[OWF Credo framework](https://credo.js.org/) is used as a decentralized identity wallet / agent implementation providing support for OID4VP (for both Holder and Verifier parties).

This is sample code not intended for production-quality usage.

## Scenario

This sample demonstrates how an agent can request additional authorization from a user using the **OID4VP In-Task Authorization Extension**.

The **Sample Agent** acts as an AI-powered assistant capable of processing user queries and generating responses using Genkit and the OpenAI API.
The agent is configured to require the user to present a verifiable credential via OID4VP before fulfilling any requests.

The following mapping applies for roles/parties described in extension spec:

- A2A Client → [CLI client](src/cli.ts)
- A2A Server → [Sample Agent Server](src/agent/index.ts)

For simplicity, OID4VP Wallet and OID4VP Verifier roles are integrated into A2A Client and A2A Server correspondingly.

1.  **Task Initiation**: A user sends a message to the Sample Agent via the A2A CLI.
2.  **Authorization Request**: The Sample Agent determines that the context/task requires authorization. It sends a `status-update` with the `auth-required` state, including OID4VP authorization request metadata.
3.  **In-Task Authorization**: The CLI client (acting as a holder) detects the OID4VP request, resolves it, and prompts the user's internal wallet (represented by Credo in the CLI) to present the requested credentials.
4.  **Verification**: The Sample Agent (acting as a verifier) receives and validates the presentation.
5.  **Task Execution**: Once authorized, the Sample Agent proceeds with the task and generates a response.

## Running the Sample

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [pnpm](https://pnpm.io/)
- An OpenAI API key

### 2. Setup

Navigate to the `sample` directory and install dependencies:

```bash
cd sample
pnpm install
```

Copy the `.env.example` file to `.env` and add your OpenAI API key:

```bash
cp .env.example .env
# Edit .env and set your OPENAI_API_KEY
```

### 3. Run the Agent

In one terminal, start the Sample Agent:

```bash
npm run agent
```

The agent will start an A2A server (port 3000) and an OID4VP verifier server (port 3001).

### 4. Run the CLI Client

In a separate terminal, start the A2A CLI:

```bash
npm run client
```

You can now interact with the agent. The first message you send will trigger the OID4VP authorization flow.

## Disclaimer

Important: The sample code provided is for demonstration purposes and illustrates the
mechanics of the Agent-to-Agent (A2A) protocol and OID4VP In-Task authorization Extension. When building production applications,
it is critical to treat any agent operating outside of your direct control as a
potentially untrusted entity.

All data received from an external agent—including but not limited to its AgentCard,
messages, artifacts, and task statuses—should be handled as untrusted input. For
example, a malicious agent could provide an AgentCard containing crafted data in its
fields (e.g., description, name, skills.description). If this data is used without
sanitization to construct prompts for a Large Language Model (LLM), it could expose
your application to prompt injection attacks. Failure to properly validate and
sanitize this data before use can introduce security vulnerabilities into your
application.

Developers are responsible for implementing appropriate security measures, such as
input validation and secure handling of credentials to protect their systems and users.
