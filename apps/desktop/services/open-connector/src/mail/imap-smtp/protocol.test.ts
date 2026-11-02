import type { Socket, TcpNetConnectOpts } from "node:net";

import { lookup } from "node:dns";
import { EventEmitter } from "node:events";
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

  it("opens the SMTP socket itself through the OS resolver instead of nodemailer's c-ares lookup", async () => {
    let transportConfig: Record<string, unknown> = {};
    const verify = vi.fn(async () => true);
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn() }) as unknown as Socket;
    const connectSocket = vi.fn((_options: TcpNetConnectOpts) => socket);
    const protocol = createMailProtocol(
      { displayName: "Test Mail", attachmentFallbackPrefix: "test-mail" },
      {
        createSmtpTransport: (config) => {
          transportConfig = config;
          return { verify, sendMail: vi.fn(), close: vi.fn() };
        },
        connectSocket,
      },
    );

    await protocol.validateSmtpCredential({
      email: "sender@example.com",
      authorizationCode: "secret",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
    });

    expect(verify).toHaveBeenCalledOnce();
    expect(transportConfig).toMatchObject({ host: "smtp.example.com", port: 465, secure: true });
    const getSocket = transportConfig.getSocket as (
      options: unknown,
      callback: (error: Error | null, options?: { connection: Socket }) => void,
    ) => void;
    expect(typeof getSocket).toBe("function");

    const callback = vi.fn();
    getSocket({}, callback);
    socket.emit("connect");

    const options = connectSocket.mock.calls[0]![0];
    expect(options).toMatchObject({ host: "smtp.example.com", port: 465 });
    expect(options.lookup).toBe(lookup);
    expect(callback).toHaveBeenCalledWith(null, { connection: socket });
  });
});
