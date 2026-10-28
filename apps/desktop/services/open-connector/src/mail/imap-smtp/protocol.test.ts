import { describe, expect, it, vi } from "vitest";

import { createMailProtocol } from "./protocol.ts";

describe("IMAP/SMTP mail protocol", () => {
  it("fetches the complete sent-message source before parsing its text body", async () => {
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
      return {
        source: Buffer.from(
          [
            "From: sender@example.com",
            "To: recipient@example.com",
            "Subject: Test message",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "Hello Sent!",
          ].join("\r\n"),
        ),
      };
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
      { source: true },
      { uid: true },
    );
    expect(message.text).toBe("Hello Sent!");
  });

  it("falls back to MIME body parts when the IMAP server omits the complete source", async () => {
    const fetchOne = vi.fn(async (_uid: number, query: Record<string, unknown>) => {
      if (query.bodyStructure) {
        return {
          uid: 42,
          envelope: {
            subject: "Fallback message",
            from: [{ address: "sender@example.com" }],
            to: [{ address: "recipient@example.com" }],
          },
          bodyStructure: {
            type: "text/plain",
            parameters: { charset: "utf-8" },
            encoding: "quoted-printable",
            size: 15,
          },
        };
      }
      if (query.source) {
        return {};
      }
      return {
        bodyParts: new Map([["TEXT", Buffer.from("Hello fallback!", "utf8")]]),
      };
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
      { bodyParts: [{ key: "TEXT", maxLength: 15 }] },
      { uid: true },
    );
    expect(message.text).toBe("Hello fallback!");
  });
});
