import { z } from "zod";

// The protocol string identifies the provider; Codex keeps its original identifier so archived runs stay valid.
export const protocolIds = ["tanteki-isolated-v1", "tanteki-isolated-claude-v1"] as const;
export const protocolSchema = z.enum(protocolIds);
export type ProtocolId = z.infer<typeof protocolSchema>;
export const providerSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof providerSchema>;
export const protocolOf = (provider: Provider): ProtocolId => provider === "claude" ? "tanteki-isolated-claude-v1" : "tanteki-isolated-v1";
export const providerOf = (protocol: ProtocolId): Provider => protocol === "tanteki-isolated-claude-v1" ? "claude" : "codex";
export const efforts = { codex: ["minimal", "low", "medium", "high", "xhigh"], claude: ["low", "medium", "high", "xhigh", "max"] } as const;
export const effortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
