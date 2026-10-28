import { describe, expect, it, vi } from "vitest";

import { createMailProtocol } from "./protocol.ts";

describe("IMAP/SMTP mail protocol", () => {
  it("fetches the root text body of a single-part Sent message via BODY[TEXT]", async () => {
    const fetchOne = vi.fn(async (_uid: number, query: Record<string, unknown>) => {
      if (query.bodyStructure) {
        return {
          uid: 42,
          envelope: {
            subject: "Test message",
            from: [{ address: "sender@example.com" }],
            to: [{ address: "recipient@example.com" }],
          },
          bodyStructure: {
            type: "text/plain",
            parameters: { charset: "utf-8" },
            encoding: "quoted-printable",
            size: 12,
          },
        };
      }
      return { bodyParts: new Map([["TEXT", Buffer.from("Hello Sent!")]]) };
    });
    const client = {
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      mailboxOpen: vi.fn(async () => {}),
      fetchOne,
    };
    const protocol = createMailProtocol(
      { displayName: "Test Mail", attachmentFallbackPrefix: "test-mail" },
      { createImapClient: () => client },
    );

    const message = await protocol.fetchMessage(
      {
        email: "sender@example.com",
        authorizationCode: "secret",
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
      },
      "Sent Items",
      42,
      { maxBytes: 1024 },
    );

    expect(fetchOne).toHaveBeenLastCalledWith(
      42,
      { bodyParts: [{ key: "TEXT", maxLength: 12 }] },
      { uid: true },
    );
    expect(message.text).toBe("Hello Sent!");
  });
});
