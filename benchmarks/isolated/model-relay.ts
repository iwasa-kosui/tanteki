import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";
import { parseJSON, schemaResult, messageOf, assertNever } from "./validation.ts";
import type { WorkerEmit } from "./worker-message.ts";

const bodyLimit = 16 * 1024 * 1024;
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("response"), id: z.number().int().positive(), status: z.number().int().min(100).max(599), contentType: z.string().regex(/^[^\r\n]+$/) }),
  z.object({ type: z.literal("chunk"), id: z.number().int().positive(), data: z.string().max(bodyLimit).regex(/^[A-Za-z0-9+/]*={0,2}$/) }),
  z.object({ type: z.literal("end"), id: z.number().int().positive() })
]);
export const parseRelayReply = (line: string) => parseJSON(line).andThen(schemaResult(frameSchema));
type PendingRequest = Readonly<{ kind: "AwaitingHeaders" | "Streaming"; response: ServerResponse }>;
export type ModelRelay = Readonly<{ listen: () => Promise<void>; enable: () => void; close: () => void }>;

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    size += chunk.length;
    if (size > bodyLimit) throw new Error("Model request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const ModelRelay = {
  create: ({ input, emit }: { input: Readable; emit: WorkerEmit }): ModelRelay => {
    let state: "Blocked" | "Ready" | "Closed" = "Blocked";
    let nextId = 0;
    let replies: Interface | undefined;
    const requests = new Map<number, PendingRequest>();
    const reject = (message: string) => emit({ type: "violation", message });

    async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
      try {
        if (state !== "Ready" || request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(403); response.end("Unsupported model transport");
          reject("Unapproved model transport or request before preflight");
          return;
        }
        const body = await readBody(request);
        const id = ++nextId;
        requests.set(id, { kind: "AwaitingHeaders", response });
        emit({ type: "request", id, encoding: request.headers["content-encoding"] ?? "identity", data: body.toString("base64") });
        response.on("close", () => requests.delete(id));
      } catch (error) { response.destroy(); reject(messageOf(error)); }
    }

    function receive(line: string): void {
      const parsed = parseRelayReply(line);
      if (parsed.isErr()) { reject(parsed.error.message); return; }
      const frame = parsed.value;
      const pending = requests.get(frame.id);
      // A disconnected HTTP client may still have frames in transit.
      if (!pending) return;
      try {
        switch (frame.type) {
          case "response":
            if (pending.kind !== "AwaitingHeaders") throw new Error("Duplicate relay headers");
            pending.response.writeHead(frame.status, { "content-type": frame.contentType });
            requests.set(frame.id, { kind: "Streaming", response: pending.response });
            break;
          case "chunk":
            if (pending.kind !== "Streaming") throw new Error("Relay body arrived before headers");
            pending.response.write(Buffer.from(frame.data, "base64"));
            break;
          case "end":
            if (pending.kind !== "Streaming") throw new Error("Relay ended before headers");
            pending.response.end(); requests.delete(frame.id);
            break;
          default: assertNever(frame);
        }
      } catch (error) { pending.response.destroy(); requests.delete(frame.id); reject(messageOf(error)); }
    }

    const server = createServer((request, response) => { void forward(request, response); });
    return {
      listen: () => new Promise<void>((resolve, rejectListen) => {
        replies = createInterface({ input });
        replies.on("line", receive);
        server.once("error", rejectListen);
        server.listen(19876, "127.0.0.1", resolve);
      }),
      enable: () => { state = "Ready"; },
      close: () => {
        state = "Closed";
        replies?.close();
        server.closeAllConnections();
        if (server.listening) server.close();
        requests.clear();
      }
    };
  }
} as const;
