import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { Resend } from "resend";

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

function createOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );

  client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  return client;
}

function getGmail() {
  const auth = createOAuthClient();
  return google.gmail({ version: "v1", auth });
}

async function listRecentInboxMessages(maxResults = 10) {
  const gmail = getGmail();

  const res = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox newer_than:15d",
    maxResults,
  });

  return res.data.messages || [];
}

async function readMessage(messageId) {
  const gmail = getGmail();

  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  return res.data;
}

function extractHeader(message, name) {
  const headers = message.payload?.headers || [];
  const found = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return found?.value || "";
}

function decodeBase64Url(input = "") {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractTextFromPayload(payload) {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, " ");
  }

  if (payload.parts?.length) {
    for (const part of payload.parts) {
      const text = extractTextFromPayload(part);
      if (text && text.trim()) return text;
    }
  }

  return "";
}

function buildRawReply({ to, subject, body, threadId, messageId, references }) {
  const lines = [
    `To: ${to}`,
    `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ];

  if (messageId) {
    lines.push(`In-Reply-To: ${messageId}`);
  }
  if (references) {
    lines.push(`References: ${references} ${messageId || ""}`.trim());
  } else if (messageId) {
    lines.push(`References: ${messageId}`);
  }

  lines.push("", body);

  return Buffer.from(lines.join("\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

app.get("/", (req, res) => {
  res.send("API Poly-Constructions OK");
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/send-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    const result = await resend.emails.send({
      from: process.env.MAIL_FROM || "onboarding@resend.dev",
      to,
      subject,
      html: message,
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("Erreur envoi email:", error);
    res.status(500).json({
      success: false,
      error: error?.message || "Erreur serveur",
    });
  }
});

app.get("/api/gmail/status", async (req, res) => {
  try {
    const gmail = getGmail();
    await gmail.users.getProfile({ userId: "me" });

    res.json({ connected: true });
  } catch (error) {
    console.error("Erreur Gmail status:", error);
    res.status(500).json({
      connected: false,
      error: error?.message || "Gmail indisponible",
    });
  }
});

app.post("/api/gmail/poll", async (req, res) => {
  try {
    const messages = await listRecentInboxMessages(10);

    if (!messages.length) {
      return res.json({
        latestMessage: "",
        replyMessageId: "",
        autoReply: false,
      });
    }

    for (const item of messages) {
      const full = await readMessage(item.id);

      const from = extractHeader(full, "From");
      const subject = extractHeader(full, "Subject");
      const messageId = extractHeader(full, "Message-Id");
      const references = extractHeader(full, "References");
      const body = extractTextFromPayload(full.payload);

      const isLikelyProspectReply =
        from &&
        !from.toLowerCase().includes("no-reply") &&
        !from.toLowerCase().includes("mailer-daemon");

      if (isLikelyProspectReply) {
        return res.json({
          latestMessage: body || subject || "Réponse reçue",
          replyMessageId: item.id,
          autoReply: true,
          meta: {
            from,
            subject,
            threadId: full.threadId,
            messageId,
            references,
          },
        });
      }
    }

    return res.json({
      latestMessage: "",
      replyMessageId: "",
      autoReply: false,
    });
  } catch (error) {
    console.error("Erreur Gmail poll:", error);
    res.status(500).json({
      error: error?.message || "Erreur Gmail poll",
    });
  }
});

app.post("/api/gmail/reply", async (req, res) => {
  try {
    const { replyMessageId, body } = req.body;

    if (!replyMessageId || !body) {
      return res.status(400).json({
        success: false,
        error: "replyMessageId et body sont obligatoires",
      });
    }

    const gmail = getGmail();
    const original = await readMessage(replyMessageId);

    const from = extractHeader(original, "From");
    const replyTo = extractHeader(original, "Reply-To") || from;
    const subject = extractHeader(original, "Subject") || "";
    const messageId = extractHeader(original, "Message-Id") || "";
    const references = extractHeader(original, "References") || "";
    const threadId = original.threadId;

    const raw = buildRawReply({
      to: replyTo,
      subject,
      body,
      threadId,
      messageId,
      references,
    });

    const sendRes = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId,
      },
    });

    res.json({
      success: true,
      id: sendRes.data.id,
      threadId: sendRes.data.threadId,
    });
  } catch (error) {
    console.error("Erreur Gmail reply:", error);
    res.status(500).json({
      success: false,
      error: error?.message || "Erreur Gmail reply",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur fonctionnant sur le port ${PORT}`);
});
