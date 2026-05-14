# OID4VP In-Task Authorization Extension

> **Experimental:** This extension currently has experimental status — breaking changes are possible and community feedback is much appreciated. To learn more about the extension lifecycle, please refer to [A2A Extension and Protocol Binding Governance](https://a2a-protocol.org/latest/topics/extension-and-binding-governance/).

This repository contains the specification for the **OID4VP In-Task Authorization Extension** for the Agent2Agent (A2A) protocol.

## Purpose

The OpenID for Verifiable Presentations (OID4VP) In-Task Authorization extension provides an option to use OID4VP protocol for A2A In-Task authorization.

The integration of OID4VP flow allows Server Agents to perform additional authorization by requesting Verifiable Presentations (VPs) from the client.
Such VP-based authorization enables Just-In-Time (JIT) authorization – server can dynamically request specific credentials during a Task execution without breaking the protocol flow.

Suggested integration provides clear protocol boundaries that set minimal restrictions on A2A and OID4VP protocols and allow usage of all features specified by these protocols.

## Specification

The full specification (v1 Draft) can be found [here](./v1/spec.md).

## Sample Implementation

A sample implementation of the OID4VP In-Task Authorization Extension can be found [here](./sample).