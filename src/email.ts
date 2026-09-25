import type { Env } from "./db";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(env: Env, email: Email): Promise<void> {
  if (env.EMAIL_MODE === "dev") {
    await env.DB.prepare("INSERT INTO dev_outbox (to_addr, subject, body) VALUES (?, ?, ?)")
      .bind(email.to, email.subject, email.text)
      .run();
    console.log(`[dev email] to=${email.to} subject=${email.subject}\n${email.text}`);
    return;
  }
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
